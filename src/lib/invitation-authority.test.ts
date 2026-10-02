import { describe, it, expect, vi, beforeEach } from "vitest";

const userFind = vi.fn();
const projectFind = vi.fn();
const grantFind = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/user", () => ({ User: { find: userFind } }));
vi.mock("@/models/project", () => ({ Project: { find: projectFind } }));
vi.mock("@/models/grant", () => ({ Grant: { find: grantFind } }));

const { authorityAtAcceptance } = await import("./invitation-authority");

const chain = (rows: unknown[]) => ({ select: () => ({ lean: () => Promise.resolve(rows) }) });

function world({
  people = [] as { _id: string; role: string; kind?: string }[],
  projects = [] as string[],
  owners = [] as { subject: string; object: string }[],
}) {
  userFind.mockReturnValue(chain(people));
  projectFind.mockReturnValue(chain(projects.map((_id) => ({ _id }))));
  grantFind.mockReturnValue(chain(owners));
}

const board = (project: string, addedBy: string, relation: "owner" | "member" = "member") => ({
  project,
  addedBy,
  relation,
});

beforeEach(() => vi.clearAllMocks());

describe("what an invitation may still grant when it is accepted", () => {
  it("keeps everything an administrator sent while they are still one", async () => {
    world({ people: [{ _id: "a1", role: "admin" }], projects: ["p1"] });

    const authority = await authorityAtAcceptance({
      role: "admin",
      invitedBy: "a1",
      boards: [board("p1", "a1", "owner")],
    } as never);

    expect(authority).toEqual({ role: "admin", boards: [board("p1", "a1", "owner")] });
  });

  // The control for the case below: same invitation, same world, except the inviter's standing
  // Still owning the board is what keeps the rest of the invitation alive, so only the role check
  // stands between a demoted inviter and a new administrator
  it("refuses an administrator invitation whose inviter has been demoted", async () => {
    world({
      people: [{ _id: "a1", role: "member" }],
      projects: ["p1"],
      owners: [{ subject: "a1", object: "p1" }],
    });

    expect(
      await authorityAtAcceptance({
        role: "admin",
        invitedBy: "a1",
        boards: [board("p1", "a1")],
      } as never)
    ).toBeNull();
  });

  it("refuses an invitation whose inviter was deleted", async () => {
    world({ people: [], projects: ["p1"] });

    expect(
      await authorityAtAcceptance({
        role: "member",
        invitedBy: "a1",
        boards: [board("p1", "a1")],
      } as never)
    ).toBeNull();
  });

  it("never counts a machine account as an administrator", async () => {
    world({ people: [{ _id: "a1", role: "admin", kind: "machine" }], projects: ["p1"] });

    expect(
      await authorityAtAcceptance({ role: "admin", invitedBy: "a1", boards: [] } as never)
    ).toBeNull();
  });

  it("drops a board that was deleted in the meantime", async () => {
    world({ people: [{ _id: "a1", role: "admin" }], projects: ["p1"] });

    const authority = await authorityAtAcceptance({
      role: "member",
      invitedBy: "a1",
      boards: [board("p1", "a1"), board("gone", "a1")],
    } as never);

    expect(authority?.boards).toEqual([board("p1", "a1")]);
  });

  it("keeps a board added by somebody who still owns it", async () => {
    world({
      people: [{ _id: "o1", role: "member" }],
      projects: ["p1", "p2"],
      owners: [{ subject: "o1", object: "p1" }],
    });

    const authority = await authorityAtAcceptance({
      role: "member",
      invitedBy: "o1",
      boards: [board("p1", "o1"), board("p2", "o1")],
    } as never);

    expect(authority).toEqual({ role: "member", boards: [board("p1", "o1")] });
  });

  it("refuses an owner's invitation once they own none of its boards", async () => {
    world({ people: [{ _id: "o1", role: "member" }], projects: ["p1"], owners: [] });

    expect(
      await authorityAtAcceptance({
        role: "member",
        invitedBy: "o1",
        boards: [board("p1", "o1")],
      } as never)
    ).toBeNull();
  });
});
