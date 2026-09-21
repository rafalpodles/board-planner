import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const projectLean = vi.fn();
const grantFind = vi.fn();
const grantLean = vi.fn();
const userFind = vi.fn();
const userLean = vi.fn();
const workerFind = vi.fn();
const workerLean = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/grants")>();
  return { ...actual, check, accessibleProjectIds: vi.fn() };
});
// Honours the projection it is given, so a field the route forgets to select is absent here too
function projected(doc: Record<string, unknown> | null, projection: string) {
  if (!doc) return null;
  const keep = new Set(["_id", ...projection.split(/\s+/).filter(Boolean)]);
  return Object.fromEntries(Object.entries(doc).filter(([k]) => keep.has(k)));
}
vi.mock("@/models/project", () => ({
  Project: {
    findById: (_id: string, projection: string) => ({
      lean: async () => projected(await projectLean(), projection),
    }),
    findOne: vi.fn(),
  },
}));
vi.mock("@/models/grant", () => ({
  Grant: { find: (...a: unknown[]) => (grantFind(...a), { select: () => ({ lean: grantLean }) }) },
}));
vi.mock("@/models/user", () => ({
  User: { find: (...a: unknown[]) => (userFind(...a), { sort: () => ({ lean: userLean }) }) },
}));
vi.mock("@/models/worker", () => ({
  Worker: { find: (...a: unknown[]) => (workerFind(...a), { lean: workerLean }) },
}));
vi.mock("@/models/task", () => ({ Task: {} }));

const { GET } = await import("./route");

const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const params = Promise.resolve({ projectId: PROJECT });
const READER = "507f1f77bcf86cd799439011";
const OWNER = "507f1f77bcf86cd799439012";

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: READER, role: "member" });
  check.mockImplementation(async (_user: unknown, _project: string, need: string) => need === "access");
  projectLean.mockResolvedValue({ _id: PROJECT, repositoryUrl: "https://github.com/acme/orbit" });
  grantLean.mockResolvedValue([{ subject: OWNER }]);
  userLean.mockResolvedValue([
    { _id: OWNER, username: "ada", fullName: "Ada", email: "ada@example.com", role: "member" },
  ]);
  workerLean.mockResolvedValue([]);
});

async function read() {
  const res = await GET(new Request("http://x"), { params });
  return { status: res.status, body: await res.json() };
}

/**
 * BP-727. What a member's task screen may learn about the board and about machines. The privacy
 * boundary is the worker query: it is the reader's own machines, never the assignee's.
 */
describe("GET handover readiness", () => {
  it("asks only about the reader's own machines", async () => {
    await read();

    expect(workerFind.mock.calls[0][0]).toEqual({ owner: READER });
  });

  it("names the board's owners, and only their names", async () => {
    const { body } = await read();

    expect(grantFind).toHaveBeenCalledWith({ objectType: "project", object: PROJECT, relation: "owner" });
    expect(userFind.mock.calls[0][0]).toMatchObject({ kind: { $ne: "machine" } });
    expect(userFind.mock.calls[0][1]).toBe("username fullName");
    expect(body.owners).toEqual(["Ada"]);
  });

  // Who to ask, not a roster: a username is an account handle members have no need of here
  it("names an owner with no display name by username, and sends no username otherwise", async () => {
    userLean.mockResolvedValue([
      { _id: OWNER, username: "ada", fullName: "Ada" },
      { _id: "o2", username: "kasia", fullName: "" },
    ]);

    const { body } = await read();

    expect(body.owners).toEqual(["Ada", "kasia"]);
    expect(JSON.stringify(body)).not.toContain('"ada"');
  });

  it("answers the board's own readiness, fresh, so a focus re-read sees a change made elsewhere", async () => {
    projectLean.mockResolvedValue({
      _id: PROJECT,
      repositoryUrl: "https://github.com/acme/orbit",
      worker: { enabled: true, lockedByInstance: true, policy: { secret: "x" } },
      columns: [
        { id: "todo", label: "To do", color: "#000", role: "approved", order: 0 },
        { id: "done", label: "Done", color: "#000", role: "done", order: 1 },
      ],
    });

    const { body } = await read();

    expect(body).toMatchObject({
      repositoryUrl: "https://github.com/acme/orbit",
      workerEnabled: true,
      lockedByInstance: true,
      columns: [{ role: "approved" }, { role: "done" }],
    });
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it.each([
    [true, true],
    [false, false],
  ])("says whether the reader may change the board (admin need: %s)", async (admin, expected) => {
    check.mockImplementation(async (_u: unknown, _p: string, need: string) => need === "access" || admin);

    expect((await read()).body.canAdmin).toBe(expected);
  });

  it("answers a coarse machine state and nothing about the machine itself", async () => {
    workerLean.mockResolvedValue([
      {
        enabled: true,
        lastSeenAt: new Date(),
        repos: [{ remote: "git@github.com:acme/orbit.git", path: "/Users/ada/orbit" }],
      },
    ]);

    const { body } = await read();

    expect(body.machine).toBe("live");
    expect(JSON.stringify(body)).not.toContain("/Users/ada");
  });

  // A board migrated from before repositoryUrl names its repository only in githubRepo
  it("matches a legacy board that names its repository only in githubRepo", async () => {
    projectLean.mockResolvedValue({
      _id: PROJECT,
      name: "not selected",
      githubRepo: "acme/orbit",
    });
    workerLean.mockResolvedValue([
      {
        enabled: true,
        lastSeenAt: new Date(),
        repos: [{ remote: "git@github.com:acme/orbit.git", path: "/Users/ada/orbit" }],
      },
    ]);

    expect((await read()).body.machine).toBe("live");
  });

  // The control for the projection: the same board with the field left out of the select
  it("reads nothing the projection does not select", async () => {
    projectLean.mockResolvedValue({ _id: PROJECT, gitlabHost: "acme/orbit" });
    workerLean.mockResolvedValue([
      {
        enabled: true,
        lastSeenAt: new Date(),
        repos: [{ remote: "git@github.com:acme/orbit.git", path: "/Users/ada/orbit" }],
      },
    ]);

    expect((await read()).body.machine).toBe("none");
  });

  it("answers failing for a failed sandbox check, and nothing of its detail", async () => {
    workerLean.mockResolvedValue([
      {
        enabled: true,
        lastSeenAt: new Date(),
        repos: [{ remote: "git@github.com:acme/orbit.git", path: "/Users/ada/orbit" }],
        preflight: { ok: false, checks: [{ name: "sandbox", ok: false, detail: "/private/path" }] },
      },
    ]);

    const { body } = await read();

    expect(body.machine).toBe("failing");
    expect(JSON.stringify(body)).not.toContain("/private/path");
  });

  it("selects what pause and preflight are read from", async () => {
    await read();

    expect(workerFind.mock.calls[0][1].split(" ").sort()).toEqual(
      ["enabled", "lastSeenAt", "repos", "preflight", "command", "commandIssuedAt", "commandAckedAt"].sort()
    );
  });

  it("answers none when the reader has no machine", async () => {
    expect((await read()).body.machine).toBe("none");
  });

  it("refuses a reader who cannot reach the board, and reads nothing", async () => {
    check.mockResolvedValue(false);

    expect((await read()).status).toBe(403);
    expect(workerFind).not.toHaveBeenCalled();
  });

  it("answers 404 for a board that is gone", async () => {
    projectLean.mockResolvedValue(null);

    expect((await read()).status).toBe(404);
  });
});
