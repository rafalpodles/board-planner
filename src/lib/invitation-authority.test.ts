import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

const userFind = vi.fn();
const projectFind = vi.fn();
const grantFind = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/user", () => ({ User: { find: userFind } }));
vi.mock("@/models/project", () => ({ Project: { find: projectFind } }));
vi.mock("@/models/grant", () => ({ Grant: { find: grantFind } }));

const { authorityAtAcceptance } = await import("./invitation-authority");

const oid = () => new Types.ObjectId();
const same = (a: unknown, b: unknown) => String(a) === String(b);
const inIds = (ids: unknown[], value: unknown) => ids.some((id) => same(id, value));

type Person = { _id: Types.ObjectId; role: string; kind?: string };
type GrantRow = { subject: Types.ObjectId; object: Types.ObjectId; relation: string };

// Each mock applies the filter and the projection production sends, so a query that stopped
// asking for owners, or stopped loading `kind`, changes the answer here too
function world({
  people = [] as Person[],
  projects = [] as Types.ObjectId[],
  grants = [] as GrantRow[],
}) {
  userFind.mockImplementation((filter: { _id: { $in: unknown[] } }) => ({
    select: (fields: string) => ({
      lean: () =>
        Promise.resolve(
          people
            .filter((p) => inIds(filter._id.$in, p._id))
            .map((p) => ({
              _id: p._id,
              ...(fields.includes("role") ? { role: p.role } : {}),
              ...(fields.includes("kind") ? { kind: p.kind ?? "human" } : {}),
            }))
        ),
    }),
  }));
  projectFind.mockImplementation((filter: { _id: { $in: unknown[] } }) => ({
    select: () => ({
      lean: () =>
        Promise.resolve(projects.filter((id) => inIds(filter._id.$in, id)).map((_id) => ({ _id }))),
    }),
  }));
  grantFind.mockImplementation(
    (filter: { relation?: string; subject: { $in: unknown[] }; object: { $in: unknown[] } }) => ({
      select: () => ({
        lean: () =>
          Promise.resolve(
            grants.filter(
              (g) =>
                (filter.relation === undefined || g.relation === filter.relation) &&
                inIds(filter.subject.$in, g.subject) &&
                inIds(filter.object.$in, g.object)
            )
          ),
      }),
    })
  );
}

const board = (
  project: Types.ObjectId,
  addedBy: Types.ObjectId,
  relation: "owner" | "member" = "member"
) => ({ project, addedBy, relation });

const admin = oid();
const owner = oid();
const p1 = oid();
const p2 = oid();

beforeEach(() => vi.clearAllMocks());

describe("what an invitation may still grant when it is accepted", () => {
  it("keeps everything an administrator sent while they are still one", async () => {
    world({ people: [{ _id: admin, role: "admin" }], projects: [p1] });

    const authority = await authorityAtAcceptance({
      role: "admin",
      invitedBy: admin,
      boards: [board(p1, admin, "owner")],
    } as never);

    expect(authority).toEqual({ role: "admin", boards: [board(p1, admin, "owner")] });
  });

  // Still owning the board is what keeps the rest of the invitation alive, so only the role check
  // stands between a demoted inviter and a new administrator
  it("refuses an administrator invitation whose inviter has been demoted", async () => {
    world({
      people: [{ _id: admin, role: "member" }],
      projects: [p1],
      grants: [{ subject: admin, object: p1, relation: "owner" }],
    });

    expect(
      await authorityAtAcceptance({
        role: "admin",
        invitedBy: admin,
        boards: [board(p1, admin)],
      } as never)
    ).toBeNull();
  });

  it("never counts a machine account as an administrator", async () => {
    world({ people: [{ _id: admin, role: "admin", kind: "machine" }], projects: [p1] });

    expect(
      await authorityAtAcceptance({ role: "admin", invitedBy: admin, boards: [] } as never)
    ).toBeNull();
  });

  it("drops a board that was deleted in the meantime", async () => {
    world({ people: [{ _id: admin, role: "admin" }], projects: [p1] });

    const authority = await authorityAtAcceptance({
      role: "member",
      invitedBy: admin,
      boards: [board(p1, admin), board(p2, admin)],
    } as never);

    expect(authority?.boards).toEqual([board(p1, admin)]);
  });

  it("keeps a board added by somebody who still owns it, and only that one", async () => {
    world({
      people: [{ _id: owner, role: "member" }],
      projects: [p1, p2],
      grants: [{ subject: owner, object: p1, relation: "owner" }],
    });

    const authority = await authorityAtAcceptance({
      role: "member",
      invitedBy: owner,
      boards: [board(p1, owner), board(p2, owner)],
    } as never);

    expect(authority).toEqual({ role: "member", boards: [board(p1, owner)] });
  });

  // Being a member of a board does not let you grant it
  it("refuses an owner's invitation once they are only a member of its board", async () => {
    world({
      people: [{ _id: owner, role: "member" }],
      projects: [p1],
      grants: [{ subject: owner, object: p1, relation: "member" }],
    });

    expect(
      await authorityAtAcceptance({
        role: "member",
        invitedBy: owner,
        boards: [board(p1, owner)],
      } as never)
    ).toBeNull();
  });

  // A grant can outlive its account (a deletion that failed half-way); it still backs nothing
  it("refuses a board added by somebody since deleted, whatever grant they left behind", async () => {
    world({ people: [], projects: [p1], grants: [{ subject: owner, object: p1, relation: "owner" }] });

    expect(
      await authorityAtAcceptance({
        role: "member",
        invitedBy: owner,
        boards: [board(p1, owner)],
      } as never)
    ).toBeNull();
  });
});
