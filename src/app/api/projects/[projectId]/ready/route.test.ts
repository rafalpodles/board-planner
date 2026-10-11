import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_ORGANISATION_ID } from "@/lib/organisation-field";

const getAuthUser = vi.fn();
const check = vi.fn();
const projectLean = vi.fn();
const workerFind = vi.fn();
const taskExists = vi.fn();
const grantCount = vi.fn();
const userLean = vi.fn();
const userUpdate = vi.fn();

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
  Project: { findOne: () => ({ lean: projectLean }) },
}));
vi.mock("@/models/worker", () => ({
  Worker: { find: (...a: unknown[]) => (workerFind(...a), { lean: async () => [] }) },
}));
vi.mock("@/models/task", () => ({ Task: { exists: taskExists } }));
vi.mock("@/models/grant", () => ({ Grant: { countDocuments: grantCount } }));
vi.mock("@/models/user", () => ({
  User: { findOne: () => ({ lean: userLean }), updateOne: userUpdate },
}));

const { GET, PUT } = await import("./route");

const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const params = Promise.resolve({ projectId: PROJECT });
const READER = "507f1f77bcf86cd799439011";

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: READER, role: "member" });
  check.mockImplementation(async () => true);
  projectLean.mockResolvedValue({ _id: PROJECT, repositoryUrl: "", worker: { enabled: false } });
  taskExists.mockResolvedValue(null);
  grantCount.mockResolvedValue(1);
  userLean.mockResolvedValue({ dismissedBoardReady: [] });
});

async function read() {
  const res = await GET(new Request("http://x"), { params });
  return { status: res.status, body: await res.json() };
}

describe("GET board ready", () => {
  it("answers nothing, and reads nothing, for somebody who may not change the board", async () => {
    check.mockImplementation(async (_db: unknown, _user: unknown, _project: string, need: string) => need === "access");

    const { status, body } = await read();

    expect(status).toBe(200);
    expect(body).toEqual({ show: false, steps: [] });
    expect(projectLean).not.toHaveBeenCalled();
    expect(grantCount).not.toHaveBeenCalled();
    expect(workerFind).not.toHaveBeenCalled();
  });

  it("derives each step from what exists and asks only about the reader's own machines", async () => {
    taskExists.mockResolvedValue({ _id: "t" });
    grantCount.mockResolvedValue(2);

    const { body } = await read();

    expect(body.show).toBe(true);
    expect(Object.fromEntries(body.steps.map((s: { id: string; done: boolean }) => [s.id, s.done]))).toEqual({
      board: true,
      tasks: true,
      team: true,
      repository: false,
      runs: false,
      machine: false,
    });
    expect(workerFind.mock.calls[0][0]).toEqual({ owner: READER, organisation: DEFAULT_ORGANISATION_ID });
  });

  it("is hidden for a person who hid it, though steps are still open", async () => {
    userLean.mockResolvedValue({ dismissedBoardReady: [PROJECT] });

    const { body } = await read();

    expect(body.show).toBe(false);
    expect(body.steps.some((s: { done: boolean }) => !s.done)).toBe(true);
  });

  it("still shows while only the machine is missing", async () => {
    taskExists.mockResolvedValue({ _id: "t" });
    grantCount.mockResolvedValue(3);
    projectLean.mockResolvedValue({
      _id: PROJECT,
      repositoryUrl: "https://github.com/acme/orbit",
      worker: { enabled: true },
    });

    const { body } = await read();

    expect(body.steps.filter((s: { done: boolean }) => !s.done).map((s: { id: string }) => s.id)).toEqual(["machine"]);
    expect(body.show).toBe(true);
  });

  it("answers 404 for a board that is gone", async () => {
    projectLean.mockResolvedValue(null);

    expect((await read()).status).toBe(404);
  });
});

describe("PUT board ready", () => {
  const hide = () => PUT(new Request("http://x", { method: "PUT" }), { params });

  it("records the board against the reader, bounded", async () => {
    const res = await hide();

    expect(res.status).toBe(200);
    expect(userUpdate).toHaveBeenCalledTimes(1);
    const [filter, update] = userUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: READER, organisation: DEFAULT_ORGANISATION_ID });
    expect(update).toEqual({ $push: { dismissedBoardReady: { $each: [PROJECT], $slice: -200 } } });
  });

  it("does not record it twice", async () => {
    userLean.mockResolvedValue({ dismissedBoardReady: [PROJECT] });

    expect((await hide()).status).toBe(200);
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
