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
vi.mock("@/models/project", () => ({
  Project: { findById: () => ({ lean: projectLean }), findOne: vi.fn() },
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
  check.mockResolvedValue(true);
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

    expect(workerFind).toHaveBeenCalledWith({ owner: READER }, "enabled lastSeenAt repos");
  });

  it("names the board's owners, and only their names", async () => {
    const { body } = await read();

    expect(grantFind).toHaveBeenCalledWith({ objectType: "project", object: PROJECT, relation: "owner" });
    expect(userFind.mock.calls[0][0]).toMatchObject({ kind: { $ne: "machine" } });
    expect(userFind.mock.calls[0][1]).toBe("username fullName");
    expect(body.owners).toEqual([{ username: "ada", fullName: "Ada" }]);
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

    expect(body).toEqual({ owners: [{ username: "ada", fullName: "Ada" }], machine: "live" });
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
