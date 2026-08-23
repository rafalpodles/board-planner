import { describe, it, expect, vi, beforeEach } from "vitest";
import { decide, Principal, principalOf } from "./grants";
import { IUser } from "@/types";
import { Types } from "mongoose";

const P = "69a52e3b399b27d3cbb2c5a5";
const OTHER = "69a52e3b399b27d3cbb2c5a6";

function principal(over: Partial<Principal> = {}): Principal {
  return {
    instanceAdmin: false,
    tokenScoped: false,
    tokenScope: null,
    instanceAdminBeforeScope: false,
    ...over,
  };
}

function fakeUser(over: Partial<IUser> = {}) {
  return {
    _id: new Types.ObjectId(),
    username: "test",
    password: "hash",
    fullName: "Test User",
    email: "test@example.com",
    emailNotifications: true,
    collapseEmptyColumns: false,
    role: "member" as const,
    kind: "human" as const,
    createdAt: new Date(),
    ...over,
  } as IUser;
}

describe("decide", () => {
  it("gives an instance admin both access and admin without any grant", () => {
    const p = principal({ instanceAdmin: true });
    expect(decide(p, null, "access", P)).toBe(true);
    expect(decide(p, null, "admin", P)).toBe(true);
  });

  it("gives an owner both access and admin", () => {
    const p = principal();
    expect(decide(p, "owner", "access", P)).toBe(true);
    expect(decide(p, "owner", "admin", P)).toBe(true);
  });

  it("gives a member access but never admin", () => {
    const p = principal();
    expect(decide(p, "member", "access", P)).toBe(true);
    expect(decide(p, "member", "admin", P)).toBe(false);
  });

  it("refuses someone with no grant at all", () => {
    const p = principal();
    expect(decide(p, null, "access", P)).toBe(false);
    expect(decide(p, null, "admin", P)).toBe(false);
  });

  it("refuses a project outside a token's scope even to an owner", () => {
    const p = principal({ tokenScoped: true, tokenScope: [OTHER] });
    expect(decide(p, "owner", "access", P)).toBe(false);
  });

  it("never lets a scoped token administer, even as owner in scope", () => {
    const p = principal({ tokenScoped: true, tokenScope: [P] });
    expect(decide(p, "owner", "admin", P)).toBe(false);
    expect(decide(p, "owner", "access", P)).toBe(true);
  });

  // The regression the spec is built around: applyTokenScope downgrades an instance admin to
  // member, and instance admins hold no grant rows, so a naive lookup strips all their access.
  it("keeps an instance admin's scoped token working inside its scope", () => {
    const p = principal({ tokenScoped: true, tokenScope: [P], instanceAdminBeforeScope: true });
    expect(decide(p, null, "access", P)).toBe(true);
    expect(decide(p, null, "admin", P)).toBe(false);
  });

  it("still confines an instance admin's scoped token to its scope", () => {
    const p = principal({ tokenScoped: true, tokenScope: [OTHER], instanceAdminBeforeScope: true });
    expect(decide(p, null, "access", P)).toBe(false);
  });
});

describe("principalOf", () => {
  it("maps a plain user to the right principal", () => {
    const user = fakeUser({ role: "member" });
    expect(principalOf(user)).toEqual({
      instanceAdmin: false,
      tokenScoped: false,
      tokenScope: null,
      instanceAdminBeforeScope: false,
    });
  });

  it("maps an instance admin correctly", () => {
    const user = fakeUser({ role: "admin" });
    const result = principalOf(user);
    expect(result.instanceAdmin).toBe(true);
  });

  it("converts tokenScope ObjectIds to strings", () => {
    const objectId = new Types.ObjectId(P);
    const user = fakeUser({
      role: "member",
      tokenScoped: true,
      tokenScope: [objectId],
      instanceAdminBeforeScope: true,
    });
    const result = principalOf(user);
    expect(result.tokenScope).toEqual([P]);
    expect(result.tokenScoped).toBe(true);
    expect(result.instanceAdminBeforeScope).toBe(true);
  });
});

const findOne = vi.fn();
const find = vi.fn();
const userFind = vi.fn();
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/grant", () => ({
  Grant: {
    findOne: (...args: unknown[]) => findOne(...args),
    find: (...args: unknown[]) => find(...args),
  },
}));
vi.mock("@/models/user", () => ({
  User: { find: (...args: unknown[]) => userFind(...args) },
}));

const { check, accessibleProjectIds, recipientsWithAccess, canBeAssigned } = await import("./grants");

function lean(value: unknown) {
  return { select: () => ({ lean: () => Promise.resolve(value) }) };
}

describe("check", () => {
  beforeEach(() => {
    findOne.mockReset();
    find.mockReset();
  });

  it("reads the grant for an ordinary user", async () => {
    findOne.mockReturnValue(lean({ relation: "owner" }));
    const user = { _id: "u1", role: "member" } as never;
    expect(await check(user, P, "admin")).toBe(true);
    expect(findOne).toHaveBeenCalledWith({ subject: "u1", objectType: "project", object: P });
  });

  it("denies when the user has no grant on this project", async () => {
    findOne.mockReturnValue(lean(null));
    const user = { _id: "u1", role: "member" } as never;
    expect(await check(user, P, "access")).toBe(false);
  });

  it("answers for an instance admin without querying at all", async () => {
    const user = { _id: "a1", role: "admin" } as never;
    expect(await check(user, P, "admin")).toBe(true);
    expect(findOne).not.toHaveBeenCalled();
  });

  it("answers out-of-scope tokens without querying at all", async () => {
    const user = { _id: "u1", role: "member", tokenScoped: true, tokenScope: [OTHER] } as never;
    expect(await check(user, P, "access")).toBe(false);
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe("accessibleProjectIds", () => {
  beforeEach(() => {
    findOne.mockReset();
    find.mockReset();
  });

  it("returns null for an unscoped instance admin", async () => {
    const user = { _id: "a1", role: "admin" } as never;
    expect(await accessibleProjectIds(user)).toBe(null);
  });

  it("returns the scope for an instance admin's scoped token", async () => {
    const user = {
      _id: "a1",
      role: "member",
      tokenScoped: true,
      tokenScope: [P],
      instanceAdminBeforeScope: true,
    } as never;
    expect(await accessibleProjectIds(user)).toEqual([P]);
  });

  it("returns the granted projects for an ordinary user", async () => {
    find.mockReturnValue(lean([{ object: P }, { object: OTHER }]));
    const user = { _id: "u1", role: "member" } as never;
    expect(await accessibleProjectIds(user)).toEqual([P, OTHER]);
    expect(find).toHaveBeenCalledWith({ subject: "u1", objectType: "project" });
  });

  it("intersects grants with a token scope", async () => {
    find.mockReturnValue(lean([{ object: P }, { object: OTHER }]));
    const user = { _id: "u1", role: "member", tokenScoped: true, tokenScope: [OTHER] } as never;
    expect(await accessibleProjectIds(user)).toEqual([OTHER]);
  });
});

// The mocks below are filter-aware on purpose. An earlier version returned a fixed list and
// ignored the query, which meant the tests passed with `object`, `objectType` or `role` deleted
// from it — including the mutation that treats every recipient as an instance admin and turns the
// whole access filter into a no-op. Found by an independent review of this branch.
describe("recipientsWithAccess", () => {
  const MEMBER = "507f1f77bcf86cd799439011";
  const REMOVED = "507f1f77bcf86cd799439012";
  const ADMIN = "507f1f77bcf86cd799439013";

  /** subject id -> the grant rows that exist for them, whatever project or object type. */
  let grantRows: { subject: string; relation: string; objectType: string; object: string }[] = [];
  let roles: Record<string, string> = {};

  beforeEach(() => {
    find.mockReset();
    userFind.mockReset();
    grantRows = [];
    roles = { [MEMBER]: "member", [REMOVED]: "member", [ADMIN]: "admin" };

    find.mockImplementation((filter: Record<string, never>) => ({
      select: () => ({
        lean: async () =>
          grantRows.filter(
            (row) =>
              ((filter.subject as { $in?: string[] })?.$in ?? []).includes(row.subject) &&
              (filter.objectType === undefined || filter.objectType === row.objectType) &&
              (filter.object === undefined || filter.object === row.object)
          ),
      }),
    }));

    userFind.mockImplementation((filter: Record<string, never>) => ({
      select: () => ({
        lean: async () =>
          (((filter._id as { $in?: string[] })?.$in ?? []) as string[])
            .filter((id) => roles[id] !== undefined)
            .filter((id) => filter.role === undefined || filter.role === roles[id])
            .map((id) => ({ _id: id, role: roles[id] })),
      }),
    }));
  });

  function grant(subject: string, relation = "member", object = P, objectType = "project") {
    grantRows.push({ subject, relation, objectType, object });
  }

  it("keeps a recipient who holds a grant on the project", async () => {
    grant(MEMBER);
    expect(await recipientsWithAccess([MEMBER], P)).toEqual([MEMBER]);
  });

  it("keeps an owner as readily as a member", async () => {
    grant(MEMBER, "owner");
    expect(await recipientsWithAccess([MEMBER], P)).toEqual([MEMBER]);
  });

  it("drops a recipient whose grant on the project is gone", async () => {
    grant(MEMBER);
    expect(await recipientsWithAccess([MEMBER, REMOVED], P)).toEqual([MEMBER]);
  });

  // An instance admin reaches every board without a Grant row ever being written, so a filter
  // written as "has a grant" would silently stop notifying them — a regression wearing the
  // costume of a security fix.
  it("keeps an instance admin who holds no grant at all", async () => {
    expect(await recipientsWithAccess([ADMIN], P)).toEqual([ADMIN]);
  });

  it("does not mistake an ordinary member for an instance admin", async () => {
    roles = { [MEMBER]: "member" };
    expect(await recipientsWithAccess([MEMBER], P)).toEqual([]);
  });

  /**
   * BP-400. Assignment asks the same question delivery has asked since BP-328, so that a task
   * cannot be handed to somebody who will never be told about it and cannot open it.
   */
  describe("canBeAssigned", () => {
    it("accepts somebody who holds a grant on this board", async () => {
      grant(MEMBER);
      expect(await canBeAssigned(MEMBER, P)).toBe(true);
    });

    it("refuses somebody with no grant on it", async () => {
      expect(await canBeAssigned(REMOVED, P)).toBe(false);
    });

    it("refuses a grant held on some other board", async () => {
      grant(MEMBER, "member", OTHER);
      expect(await canBeAssigned(MEMBER, P)).toBe(false);
    });

    /**
     * The acceptance case, and the one a naive "must hold a grant" rule breaks: an instance admin
     * reaches every board from their role and never has a row written for them. On an instance with
     * one admin, refusing this takes the only person who can see everything out of every picker.
     */
    it("accepts an instance admin who holds no grant at all", async () => {
      expect(await canBeAssigned(ADMIN, P)).toBe(true);
    });

    /**
     * `pm` is stored as an ordinary member with no grants, and the ticket asked whether it needed a
     * carve-out. It does not: nothing in the codebase ever assigns a task TO the PM account — it
     * appears only as the actor of a turn — so refusing it costs nothing that works today. This
     * pins that decision, and fails the moment somebody special-cases a username here.
     */
    it("refuses the pm service account like any other member without a grant", async () => {
      const PM = "507f1f77bcf86cd799439014";
      roles[PM] = "member";
      expect(await canBeAssigned(PM, P)).toBe(false);
    });

    it("refuses an id that matches no account", async () => {
      expect(await canBeAssigned("507f1f77bcf86cd799439099", P)).toBe(false);
    });
  });

  it("ignores a grant the recipient holds on some other project", async () => {
    grant(MEMBER, "member", OTHER);
    expect(await recipientsWithAccess([MEMBER], P)).toEqual([]);
  });

  it("ignores a grant that is not a grant on a project", async () => {
    grant(MEMBER, "member", P, "sprint");
    expect(await recipientsWithAccess([MEMBER], P)).toEqual([]);
  });

  it("drops a recipient who no longer exists at all", async () => {
    roles = {};
    grant(MEMBER);
    expect(await recipientsWithAccess([MEMBER], P)).toEqual([]);
  });

  it("asks the database nothing when there is nobody to ask about", async () => {
    expect(await recipientsWithAccess([], P)).toEqual([]);
    expect(find).not.toHaveBeenCalled();
    expect(userFind).not.toHaveBeenCalled();
  });

  it("preserves the order it was given", async () => {
    grant(MEMBER);
    grant(REMOVED);
    expect(await recipientsWithAccess([REMOVED, MEMBER], P)).toEqual([REMOVED, MEMBER]);
  });
});
