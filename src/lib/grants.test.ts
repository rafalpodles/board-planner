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
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/grant", () => ({
  Grant: {
    findOne: (...args: unknown[]) => findOne(...args),
    find: (...args: unknown[]) => find(...args),
  },
}));

const { check, accessibleProjectIds } = await import("./grants");

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
