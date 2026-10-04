import { describe, it, expect, vi, beforeEach } from "vitest";
import { decide, Principal, principalOf } from "./grants";
import { IUser } from "@/types";
import { Types } from "mongoose";

const P = "69a52e3b399b27d3cbb2c5a5";
const OTHER = "69a52e3b399b27d3cbb2c5a6";
const HOME = new Types.ObjectId("000000000000000000000001");
const ELSEWHERE = new Types.ObjectId("0000000000000000000000b2");
const HERE = { id: P, tenant: HOME };

function principal(over: Partial<Principal> = {}): Principal {
  return {
    tenant: HOME,
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
    expect(decide(p, null, "access", HERE)).toBe(true);
    expect(decide(p, null, "admin", HERE)).toBe(true);
  });

  it("gives an owner both access and admin", () => {
    const p = principal();
    expect(decide(p, "owner", "access", HERE)).toBe(true);
    expect(decide(p, "owner", "admin", HERE)).toBe(true);
  });

  it("gives a member access but never admin", () => {
    const p = principal();
    expect(decide(p, "member", "access", HERE)).toBe(true);
    expect(decide(p, "member", "admin", HERE)).toBe(false);
  });

  it("refuses someone with no grant at all", () => {
    const p = principal();
    expect(decide(p, null, "access", HERE)).toBe(false);
    expect(decide(p, null, "admin", HERE)).toBe(false);
  });

  it("refuses a project outside a token's scope even to an owner", () => {
    const p = principal({ tokenScoped: true, tokenScope: [OTHER] });
    expect(decide(p, "owner", "access", HERE)).toBe(false);
  });

  it("never lets a scoped token administer, even as owner in scope", () => {
    const p = principal({ tokenScoped: true, tokenScope: [P] });
    expect(decide(p, "owner", "admin", HERE)).toBe(false);
    expect(decide(p, "owner", "access", HERE)).toBe(true);
  });

  // The regression the spec is built around: applyTokenScope downgrades an instance admin to
  // member, and instance admins hold no grant rows, so a naive lookup strips all their access.
  it("keeps an instance admin's scoped token working inside its scope", () => {
    const p = principal({ tokenScoped: true, tokenScope: [P], instanceAdminBeforeScope: true });
    expect(decide(p, null, "access", HERE)).toBe(true);
    expect(decide(p, null, "admin", HERE)).toBe(false);
  });

  it("still confines an instance admin's scoped token to its scope", () => {
    const p = principal({ tokenScoped: true, tokenScope: [OTHER], instanceAdminBeforeScope: true });
    expect(decide(p, null, "access", HERE)).toBe(false);
  });
});

describe("decide across tenants (BP-663)", () => {
  it("refuses a project of another tenant before anything else, even to an instance admin or an owner", () => {
    const elsewhere = { id: P, tenant: ELSEWHERE };
    expect(decide(principal({ instanceAdmin: true }), null, "access", elsewhere)).toBe(false);
    expect(decide(principal({ instanceAdminBeforeScope: true, tokenScope: [P] }), null, "access", elsewhere)).toBe(false);
    expect(decide(principal(), "owner", "access", elsewhere)).toBe(false);
  });

  it("refuses a project whose tenant could not be established", () => {
    expect(decide(principal({ instanceAdmin: true }), null, "access", { id: P, tenant: null })).toBe(false);
  });

  it("lets the same principal in at home", () => {
    expect(decide(principal({ instanceAdmin: true }), null, "admin", HERE)).toBe(true);
  });
});

describe("principalOf", () => {
  it("maps a plain user to the right principal", () => {
    const user = fakeUser({ role: "member" });
    expect(principalOf(user)).toEqual({
      tenant: HOME,
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
const grantDeleteMany = vi.fn();
const userFind = vi.fn();
const userDistinct = vi.fn();
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/grant", () => ({
  Grant: {
    findOne: (...args: unknown[]) => findOne(...args),
    find: (...args: unknown[]) => find(...args),
    deleteMany: (...args: unknown[]) => grantDeleteMany(...args),
  },
}));
const userExists = vi.fn(async (_filter?: unknown) => null as unknown);
vi.mock("@/models/user", () => ({
  User: {
    exists: (filter: unknown) => userExists(filter),
    find: (...args: unknown[]) => userFind(...args),
    distinct: (...args: unknown[]) => userDistinct(...args),
  },
}));
const projectFind = vi.fn();
const projectDistinct = vi.fn();
vi.mock("@/models/project", () => ({
  Project: {
    find: (...args: unknown[]) => projectFind(...args),
    distinct: (...args: unknown[]) => projectDistinct(...args),
  },
}));

const {
  check,
  accessibleProjectIds,
  administeredProjectIds,
  recipientsWithAccess,
  canBeAssigned,
  ownerCounts,
  boardsOnlyOwnedBy,
  boardsLeftWithoutOwner,
  findOrphanGrants,
  deleteOrphanGrants,
} = await import("./grants");
const { scopedToDefaultTenant } = await import("@/lib/db-scope");
const { DEFAULT_TENANT_ID } = await import("@/lib/tenant-field");

function lean(value: unknown) {
  return { select: () => ({ lean: () => Promise.resolve(value) }) };
}

let projectsElsewhere = new Set<string>();
beforeEach(() => {
  projectsElsewhere = new Set();
  projectFind.mockReset();
  projectFind.mockImplementation((filter: { _id?: { $in?: string[] } }) =>
    lean((filter?._id?.$in ?? []).filter((id) => !projectsElsewhere.has(String(id))).map((id) => ({ _id: id })))
  );
});

describe("check", () => {
  beforeEach(() => {
    findOne.mockReset();
    find.mockReset();
  });

  it("reads the grant for an ordinary user", async () => {
    findOne.mockReturnValue(lean({ relation: "owner" }));
    const user = { _id: "u1", role: "member" } as never;
    expect(await check(scopedToDefaultTenant(), user, P, "admin")).toBe(true);
    expect(findOne).toHaveBeenCalledWith({ subject: "u1", objectType: "project", object: P, tenant: DEFAULT_TENANT_ID });
  });

  it("denies when the user has no grant on this project", async () => {
    findOne.mockReturnValue(lean(null));
    const user = { _id: "u1", role: "member" } as never;
    expect(await check(scopedToDefaultTenant(), user, P, "access")).toBe(false);
  });

  it("answers for an instance admin without reading a grant", async () => {
    const user = { _id: "a1", role: "admin" } as never;
    expect(await check(scopedToDefaultTenant(), user, P, "admin")).toBe(true);
    expect(findOne).not.toHaveBeenCalled();
  });

  it("refuses a project of another tenant even to an instance admin, without reading a grant (BP-664)", async () => {
    projectsElsewhere.add(P);
    const admin = { _id: "a1", role: "admin" } as never;
    expect(await check(scopedToDefaultTenant(), admin, P, "access")).toBe(false);
    findOne.mockReturnValue(lean({ relation: "owner" }));
    expect(await check(scopedToDefaultTenant(), { _id: "u1", role: "member" } as never, P, "access")).toBe(false);
    expect(findOne).not.toHaveBeenCalled();
    expect(projectFind).toHaveBeenCalledWith({ _id: { $in: [P] }, tenant: DEFAULT_TENANT_ID });
  });

  it("refuses when the db it was handed is not the caller's own tenant", async () => {
    const admin = { _id: "a1", role: "admin", tenant: ELSEWHERE } as never;
    expect(await check(scopedToDefaultTenant(), admin, P, "access")).toBe(false);
  });

  it("refuses an id that is not a project id at all, without querying", async () => {
    const admin = { _id: "a1", role: "admin" } as never;
    expect(await check(scopedToDefaultTenant(), admin, "BP", "access")).toBe(false);
    expect(projectFind).not.toHaveBeenCalled();
  });

  it("answers out-of-scope tokens without querying at all", async () => {
    const user = { _id: "u1", role: "member", tokenScoped: true, tokenScope: [OTHER] } as never;
    expect(await check(scopedToDefaultTenant(), user, P, "access")).toBe(false);
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
    expect(await accessibleProjectIds(scopedToDefaultTenant(), user)).toBe(null);
  });

  it("returns the scope for an instance admin's scoped token", async () => {
    const user = {
      _id: "a1",
      role: "member",
      tokenScoped: true,
      tokenScope: [P],
      instanceAdminBeforeScope: true,
    } as never;
    expect(await accessibleProjectIds(scopedToDefaultTenant(), user)).toEqual([P]);
  });

  it("returns the granted projects for an ordinary user", async () => {
    find.mockReturnValue(lean([{ object: P }, { object: OTHER }]));
    const user = { _id: "u1", role: "member" } as never;
    expect(await accessibleProjectIds(scopedToDefaultTenant(), user)).toEqual([P, OTHER]);
    expect(find).toHaveBeenCalledWith({ subject: "u1", objectType: "project", tenant: DEFAULT_TENANT_ID });
  });

  it("intersects grants with a token scope", async () => {
    find.mockReturnValue(lean([{ object: P }, { object: OTHER }]));
    const user = { _id: "u1", role: "member", tokenScoped: true, tokenScope: [OTHER] } as never;
    expect(await accessibleProjectIds(scopedToDefaultTenant(), user)).toEqual([OTHER]);
  });
});

// BP-736: the batch form of check(user, id, "admin"), for the screens that decide per project
// whether this person may switch its workers on
describe("administeredProjectIds", () => {
  const THIRD = "69a52e3b399b27d3cbb2c5a7";
  // Grant rows as the store holds them: `object` is an ObjectId, not a string
  const rows = [
    { subject: "u1", objectType: "project", object: new Types.ObjectId(P), relation: "owner" },
    { subject: "u1", objectType: "project", object: new Types.ObjectId(OTHER), relation: "member" },
  ];

  beforeEach(() => {
    find.mockReset();
    find.mockImplementation((query: { subject: string; object: { $in: string[] } }) =>
      lean(
        rows.filter(
          (row) => row.subject === query.subject && query.object.$in.includes(String(row.object))
        )
      )
    );
  });

  it("includes a project the person owns and leaves out one they are only a member of", async () => {
    const user = { _id: "u1", role: "member" } as never;

    expect([...(await administeredProjectIds(scopedToDefaultTenant(), user, [P, OTHER, THIRD]))]).toEqual([P]);
  });

  it("matches a grant whose object is stored as an ObjectId", async () => {
    const user = { _id: "u1", role: "member" } as never;

    expect((await administeredProjectIds(scopedToDefaultTenant(), user, [P])).has(P)).toBe(true);
  });

  it("gives an instance admin every project without querying", async () => {
    const user = { _id: "a1", role: "admin" } as never;

    expect([...(await administeredProjectIds(scopedToDefaultTenant(), user, [P, OTHER]))]).toEqual([P, OTHER]);
    expect(find).not.toHaveBeenCalled();
  });

  it("gives a scoped token nothing, since admin needs an unscoped session", async () => {
    const user = { _id: "u1", role: "member", tokenScoped: true, tokenScope: [P] } as never;

    expect(await administeredProjectIds(scopedToDefaultTenant(), user, [P, OTHER])).toEqual(new Set());
  });

  it("leaves out a project outside the token's scope even where the person owns it", async () => {
    rows.push({ subject: "u1", objectType: "project", object: new Types.ObjectId(THIRD), relation: "owner" });
    const user = { _id: "u1", role: "member", tokenScope: [THIRD] } as never;

    expect([...(await administeredProjectIds(scopedToDefaultTenant(), user, [P, THIRD]))]).toEqual([THIRD]);
    rows.pop();
  });
});

// The mocks below are filter-aware on purpose. An earlier version returned a fixed list and
// ignored the query, which meant the tests passed with `object`, `objectType` or `role` deleted
// from it — including the mutation that treats every recipient as an instance admin and turns the
// whole access filter into a no-op. Found by an independent review of this branch.
describe("administeredProjectIds across tenants (BP-664)", () => {
  it("leaves out a project of another tenant, even for an instance admin", async () => {
    projectsElsewhere.add(OTHER);
    const admin = { _id: "a1", role: "admin" } as never;
    expect([...(await administeredProjectIds(scopedToDefaultTenant(), admin, [P, OTHER]))]).toEqual([P]);
  });
});

describe("recipientsWithAccess", () => {
  const MEMBER = "507f1f77bcf86cd799439011";
  const REMOVED = "507f1f77bcf86cd799439012";
  const ADMIN = "507f1f77bcf86cd799439013";

  /** subject id -> the grant rows that exist for them, whatever project or object type. */
  let grantRows: { subject: string; relation: string; objectType: string; object: string }[] = [];
  let roles: Record<string, string> = {};
  let deactivated = new Set<string>();

  beforeEach(() => {
    find.mockReset();
    userFind.mockReset();
    grantRows = [];
    roles = { [MEMBER]: "member", [REMOVED]: "member", [ADMIN]: "admin" };
    deactivated = new Set();

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
            .filter((id) => !("deactivatedAt" in filter) || !deactivated.has(id))
            .map((id) => ({ _id: id, role: roles[id] })),
      }),
    }));
  });

  function grant(subject: string, relation = "member", object = P, objectType = "project") {
    grantRows.push({ subject, relation, objectType, object });
  }

  it("keeps a recipient who holds a grant on the project", async () => {
    grant(MEMBER);
    expect(await recipientsWithAccess(scopedToDefaultTenant(), [MEMBER], P)).toEqual([MEMBER]);
  });

  // BP-832. Sees nothing, so is told nothing and can be handed nothing — admin or not
  it("drops a deactivated recipient, grant or instance admin role notwithstanding", async () => {
    grant(MEMBER);
    deactivated = new Set([MEMBER, ADMIN]);

    expect(await recipientsWithAccess(scopedToDefaultTenant(), [MEMBER, ADMIN], P)).toEqual([]);
    expect(await canBeAssigned(scopedToDefaultTenant(), MEMBER, P)).toBe(false);
  });

  it("keeps an owner as readily as a member", async () => {
    grant(MEMBER, "owner");
    expect(await recipientsWithAccess(scopedToDefaultTenant(), [MEMBER], P)).toEqual([MEMBER]);
  });

  it("drops a recipient whose grant on the project is gone", async () => {
    grant(MEMBER);
    expect(await recipientsWithAccess(scopedToDefaultTenant(), [MEMBER, REMOVED], P)).toEqual([MEMBER]);
  });

  // An instance admin reaches every board without a Grant row ever being written, so a filter
  // written as "has a grant" would silently stop notifying them — a regression wearing the
  // costume of a security fix.
  it("keeps an instance admin who holds no grant at all", async () => {
    expect(await recipientsWithAccess(scopedToDefaultTenant(), [ADMIN], P)).toEqual([ADMIN]);
  });

  it("does not mistake an ordinary member for an instance admin", async () => {
    roles = { [MEMBER]: "member" };
    expect(await recipientsWithAccess(scopedToDefaultTenant(), [MEMBER], P)).toEqual([]);
  });

  /**
   * BP-400. Assignment asks the same question delivery has asked since BP-328, so that a task
   * cannot be handed to somebody who will never be told about it and cannot open it.
   */
  it("keeps nobody when the project is not in this tenant, an instance admin included (BP-664)", async () => {
    grant(MEMBER);
    projectsElsewhere.add(P);
    expect(await recipientsWithAccess(scopedToDefaultTenant(), [MEMBER, ADMIN], P)).toEqual([]);
  });

  describe("canBeAssigned", () => {
    it("accepts somebody who holds a grant on this board", async () => {
      grant(MEMBER);
      expect(await canBeAssigned(scopedToDefaultTenant(), MEMBER, P)).toBe(true);
    });

    it("refuses somebody with no grant on it", async () => {
      expect(await canBeAssigned(scopedToDefaultTenant(), REMOVED, P)).toBe(false);
    });

    it("refuses a grant held on some other board", async () => {
      grant(MEMBER, "member", OTHER);
      expect(await canBeAssigned(scopedToDefaultTenant(), MEMBER, P)).toBe(false);
    });

    /**
     * The acceptance case, and the one a naive "must hold a grant" rule breaks: an instance admin
     * reaches every board from their role and never has a row written for them. On an instance with
     * one admin, refusing this takes the only person who can see everything out of every picker.
     */
    it("accepts an instance admin who holds no grant at all", async () => {
      expect(await canBeAssigned(scopedToDefaultTenant(), ADMIN, P)).toBe(true);
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
      expect(await canBeAssigned(scopedToDefaultTenant(), PM, P)).toBe(false);
    });

    it("refuses an id that matches no account", async () => {
      expect(await canBeAssigned(scopedToDefaultTenant(), "507f1f77bcf86cd799439099", P)).toBe(false);
    });
  });

  it("ignores a grant the recipient holds on some other project", async () => {
    grant(MEMBER, "member", OTHER);
    expect(await recipientsWithAccess(scopedToDefaultTenant(), [MEMBER], P)).toEqual([]);
  });

  it("ignores a grant that is not a grant on a project", async () => {
    grant(MEMBER, "member", P, "sprint");
    expect(await recipientsWithAccess(scopedToDefaultTenant(), [MEMBER], P)).toEqual([]);
  });

  it("drops a recipient who no longer exists at all", async () => {
    roles = {};
    grant(MEMBER);
    expect(await recipientsWithAccess(scopedToDefaultTenant(), [MEMBER], P)).toEqual([]);
  });

  it("asks the database nothing when there is nobody to ask about", async () => {
    expect(await recipientsWithAccess(scopedToDefaultTenant(), [], P)).toEqual([]);
    expect(find).not.toHaveBeenCalled();
    expect(userFind).not.toHaveBeenCalled();
  });

  it("preserves the order it was given", async () => {
    grant(MEMBER);
    grant(REMOVED);
    expect(await recipientsWithAccess(scopedToDefaultTenant(), [REMOVED, MEMBER], P)).toEqual([REMOVED, MEMBER]);
  });
});

describe("owner counting", () => {
  const ALICE = "507f1f77bcf86cd799439011";
  const BOB = "507f1f77bcf86cd799439012";
  const GONE = "507f1f77bcf86cd799439013";
  let ownerRows: { subject: string; object: string }[];
  let deactivatedAccounts: string[] = [];
  let accounts: string[];

  beforeEach(() => {
    find.mockReset();
    userFind.mockReset();
    projectFind.mockReset();
    ownerRows = [];
    accounts = [ALICE, BOB];
    find.mockImplementation((filter: { subject?: string; object?: { $in: string[] } }) =>
      lean(
        filter.subject
          ? ownerRows.filter((g) => g.subject === filter.subject).map((g) => ({ object: g.object }))
          : ownerRows.filter((g) => filter.object!.$in.includes(g.object))
      )
    );
    deactivatedAccounts = [];
    userFind.mockImplementation((filter: { _id: { $in: string[] }; deactivatedAt?: null }) =>
      lean(
        accounts
          .filter((id) => filter._id.$in.includes(id))
          .filter((id) => !("deactivatedAt" in filter) || !deactivatedAccounts.includes(id))
          .map((id) => ({ _id: id }))
      )
    );
    projectFind.mockImplementation((filter: { _id: { $in: string[] } }) => ({
      select: () => ({
        sort: () => ({
          lean: () =>
            Promise.resolve(filter._id.$in.map((id) => ({ _id: id, name: `Board ${id}`, key: "K" }))),
        }),
      }),
    }));
  });

  it("counts every owner a board has, and zero for a board with none", async () => {
    ownerRows = [
      { subject: ALICE, object: P },
      { subject: BOB, object: P },
    ];
    const counts = await ownerCounts(scopedToDefaultTenant(), [P, OTHER]);
    expect(counts.get(P)).toBe(2);
    expect(counts.get(OTHER)).toBe(0);
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ relation: "owner", objectType: "project" }));
  });

  it("does not count an owner row whose account is gone", async () => {
    ownerRows = [
      { subject: ALICE, object: P },
      { subject: GONE, object: P },
    ];
    expect((await ownerCounts(scopedToDefaultTenant(), [P])).get(P)).toBe(1);
  });

  // BP-832. Never counted as an owner, so deleting them leaves every board the owners it has
  it("names no board as only owned by somebody deactivated", async () => {
    ownerRows = [{ subject: ALICE, object: P }];
    userExists.mockResolvedValueOnce({ _id: ALICE });

    expect(await boardsOnlyOwnedBy(scopedToDefaultTenant(), ALICE)).toEqual([]);
    expect(userExists).toHaveBeenCalledWith({ _id: ALICE, deactivatedAt: { $ne: null }, tenant: DEFAULT_TENANT_ID });
  });

  it("names the boards a deactivation left with no active owner", async () => {
    ownerRows = [
      { subject: ALICE, object: P },
      { subject: ALICE, object: OTHER },
      { subject: BOB, object: OTHER },
    ];
    deactivatedAccounts = [ALICE];

    expect(await boardsLeftWithoutOwner(scopedToDefaultTenant(), ALICE)).toEqual([P]);
  });

  // BP-832. A deactivated owner can manage nothing, so they keep no board run
  it("does not count an owner who is deactivated", async () => {
    ownerRows = [
      { subject: ALICE, object: P },
      { subject: BOB, object: P },
    ];
    deactivatedAccounts = [BOB];

    expect((await ownerCounts(scopedToDefaultTenant(), [P])).get(P)).toBe(1);
  });

  it("names the boards the person owns alone, and not the ones they share", async () => {
    ownerRows = [
      { subject: ALICE, object: P },
      { subject: ALICE, object: OTHER },
      { subject: BOB, object: OTHER },
    ];
    expect(await boardsOnlyOwnedBy(scopedToDefaultTenant(), ALICE)).toEqual([{ _id: P, name: `Board ${P}`, key: "K" }]);
  });

  it("treats a co-owner who was deleted as no co-owner at all", async () => {
    ownerRows = [
      { subject: ALICE, object: P },
      { subject: GONE, object: P },
    ];
    expect((await boardsOnlyOwnedBy(scopedToDefaultTenant(), ALICE)).map((b) => b._id)).toEqual([P]);
  });

  it("names nothing, and loads no board, for somebody who shares every board they own", async () => {
    ownerRows = [
      { subject: ALICE, object: P },
      { subject: BOB, object: P },
    ];
    expect(await boardsOnlyOwnedBy(scopedToDefaultTenant(), ALICE)).toEqual([]);
    expect(projectFind).not.toHaveBeenCalled();
  });
});

describe("orphan grants", () => {
  const oid = () => new Types.ObjectId();
  const [LIVE_BOARD, OTHER_BOARD, GONE_BOARD] = [oid(), oid(), oid()];
  const [LIVING, ALSO_LIVING, GONE_USER] = [oid(), oid(), oid()];

  type Row = { _id: Types.ObjectId; subject: unknown; object: unknown; relation: string; objectType: string; tenant: Types.ObjectId };
  let store: Row[];
  let projects: Types.ObjectId[];
  let users: Types.ObjectId[];
  let afterParentRead: { projects?: () => void; users?: () => void };

  const row = (subject: unknown, object: unknown, relation = "member"): Row => ({
    _id: oid(),
    subject,
    object,
    relation,
    objectType: "project",
    tenant: DEFAULT_TENANT_ID,
  });

  const same = (a: unknown, b: unknown) => String(a) === String(b);
  const matches = (doc: Record<string, unknown>, query: Record<string, unknown> = {}) =>
    Object.entries(query).every(([field, cond]) => {
      const value = doc[field];
      if (cond && typeof cond === "object" && "$nin" in cond)
        return !(cond.$nin as unknown[]).some((x) => same(x, value));
      if (cond && typeof cond === "object" && "$in" in cond)
        return (cond.$in as unknown[]).some((x) => same(x, value));
      return same(cond, value);
    });

  const distinctOf = (ids: () => Types.ObjectId[], after: () => (() => void) | undefined) =>
    async (_field: string, filter?: Record<string, unknown>) => {
      const read = ids().filter((id) => matches({ _id: id, tenant: DEFAULT_TENANT_ID }, filter));
      after()?.();
      return read;
    };

  beforeEach(() => {
    projects = [LIVE_BOARD, OTHER_BOARD];
    users = [LIVING, ALSO_LIVING];
    afterParentRead = {};
    store = [
      row(LIVING, LIVE_BOARD, "owner"),
      row(ALSO_LIVING, LIVE_BOARD),
      row(LIVING, OTHER_BOARD, "owner"),
      row(LIVING, GONE_BOARD, "owner"),
      row(ALSO_LIVING, GONE_BOARD),
      row(GONE_USER, OTHER_BOARD, "owner"),
      row(GONE_USER, GONE_BOARD),
    ];
    projectDistinct.mockReset().mockImplementation(distinctOf(() => projects, () => afterParentRead.projects));
    userDistinct.mockReset().mockImplementation(distinctOf(() => users, () => afterParentRead.users));
    find.mockReset().mockImplementation((query: Record<string, unknown>) =>
      lean(store.filter((g) => matches(g, query)).map((g) => ({ ...g })))
    );
    grantDeleteMany.mockReset().mockImplementation(async (query: Record<string, unknown>) => {
      const before = store.length;
      store = store.filter((g) => !matches(g, query));
      return { deletedCount: before - store.length };
    });
  });

  const pairs = (rows: { subject: unknown; object: unknown }[]) =>
    rows.map((g) => `${g.subject}@${g.object}`).sort();

  it("finds the rows of a deleted board and of a deleted account, and nothing else", async () => {
    const orphans = await findOrphanGrants(scopedToDefaultTenant());

    expect(pairs(orphans.deletedProject)).toEqual(
      pairs([
        { subject: LIVING, object: GONE_BOARD },
        { subject: ALSO_LIVING, object: GONE_BOARD },
        { subject: GONE_USER, object: GONE_BOARD },
      ])
    );
    expect(pairs(orphans.deletedUser)).toEqual([`${GONE_USER}@${OTHER_BOARD}`]);
    expect(orphans.notObjectIds).toEqual([]);
  });

  it("counts a row whose board and account are both gone once, under the board", async () => {
    const orphans = await findOrphanGrants(scopedToDefaultTenant());
    const all = [...orphans.deletedProject, ...orphans.deletedUser].map((g) => g._id);
    expect(new Set(all).size).toBe(all.length);
    expect(pairs(orphans.deletedUser)).not.toContain(`${GONE_USER}@${GONE_BOARD}`);
  });

  it("finds nothing when every row has its board and its account", async () => {
    projects = [LIVE_BOARD, OTHER_BOARD, GONE_BOARD];
    users = [LIVING, ALSO_LIVING, GONE_USER];
    const orphans = await findOrphanGrants(scopedToDefaultTenant());
    expect(orphans.deletedProject).toEqual([]);
    expect(orphans.deletedUser).toEqual([]);
  });

  it("reports a row stored with string ids apart from the orphans, and never deletes it", async () => {
    store = [row(LIVING, LIVE_BOARD, "owner"), row(String(LIVING), String(LIVE_BOARD)), row(LIVING, String(GONE_BOARD))];

    const orphans = await findOrphanGrants(scopedToDefaultTenant());

    expect(orphans.deletedProject).toEqual([]);
    expect(orphans.deletedUser).toEqual([]);
    expect(orphans.notObjectIds).toHaveLength(2);
    expect(await deleteOrphanGrants(scopedToDefaultTenant(), orphans)).toBe(0);
    expect(store).toHaveLength(3);
  });

  it("deletes exactly the orphans, and a second pass finds and deletes nothing", async () => {
    expect(await deleteOrphanGrants(scopedToDefaultTenant(), await findOrphanGrants(scopedToDefaultTenant()))).toBe(4);
    expect(pairs(store)).toEqual(
      pairs([
        { subject: LIVING, object: LIVE_BOARD },
        { subject: ALSO_LIVING, object: LIVE_BOARD },
        { subject: LIVING, object: OTHER_BOARD },
      ])
    );

    grantDeleteMany.mockClear();
    const again = await findOrphanGrants(scopedToDefaultTenant());
    expect([...again.deletedProject, ...again.deletedUser]).toEqual([]);
    expect(await deleteOrphanGrants(scopedToDefaultTenant(), again)).toBe(0);
    expect(grantDeleteMany).not.toHaveBeenCalled();
    expect(store).toHaveLength(3);
  });

  it("keeps the owner grant of a board created while the scan reads the boards", async () => {
    const fresh = oid();
    const freshOwner = row(LIVING, fresh, "owner");
    afterParentRead.projects = () => {
      afterParentRead.projects = undefined;
      projects.push(fresh);
      store.push(freshOwner);
    };

    const orphans = await findOrphanGrants(scopedToDefaultTenant());
    const found = [...orphans.deletedProject, ...orphans.deletedUser].map((g) => g._id);
    expect(found).not.toContain(String(freshOwner._id));

    await deleteOrphanGrants(scopedToDefaultTenant(), orphans);
    expect(store).toContainEqual(freshOwner);
  });

  it("keeps the grant of an account created while the scan reads the accounts", async () => {
    const newcomer = oid();
    const theirGrant = row(newcomer, LIVE_BOARD);
    afterParentRead.users = () => {
      afterParentRead.users = undefined;
      users.push(newcomer);
      store.push(theirGrant);
    };

    const orphans = await findOrphanGrants(scopedToDefaultTenant());
    const found = [...orphans.deletedProject, ...orphans.deletedUser].map((g) => g._id);
    expect(found).not.toContain(String(theirGrant._id));

    await deleteOrphanGrants(scopedToDefaultTenant(), orphans);
    expect(store).toContainEqual(theirGrant);
  });

  it("keeps a found row whose board is back by the time it would be deleted", async () => {
    const orphans = await findOrphanGrants(scopedToDefaultTenant());
    projects.push(GONE_BOARD);

    expect(await deleteOrphanGrants(scopedToDefaultTenant(), orphans)).toBe(2);
    expect(pairs(store)).toContain(`${LIVING}@${GONE_BOARD}`);
    expect(pairs(store)).toContain(`${ALSO_LIVING}@${GONE_BOARD}`);
    expect(pairs(store)).not.toContain(`${GONE_USER}@${GONE_BOARD}`);
    expect(pairs(store)).not.toContain(`${GONE_USER}@${OTHER_BOARD}`);
  });

  it.each([
    ["no projects", () => (projects = [])],
    ["no users", () => (users = [])],
  ])("refuses to delete anything in a database with %s", async (_label, empty) => {
    empty();
    const orphans = await findOrphanGrants(scopedToDefaultTenant());

    await expect(deleteOrphanGrants(scopedToDefaultTenant(), orphans)).rejects.toThrow(/wrong database/);
    expect(grantDeleteMany).not.toHaveBeenCalled();
    expect(store).toHaveLength(7);
  });
});
