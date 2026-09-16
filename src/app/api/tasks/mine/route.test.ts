import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAuthUser, taskFind } = vi.hoisted(() => ({ getAuthUser: vi.fn(), taskFind: vi.fn() }));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ accessibleProjectIds: vi.fn() }));
vi.mock("@/models/task", () => ({ Task: { find: taskFind } }));
vi.mock("@/models/project", () => ({}));
vi.mock("@/models/worker", () => ({
  Worker: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));

const { GET } = await import("./route");

function rows(list: unknown[]) {
  const self = { populate: () => self, sort: () => self, lean: () => Promise.resolve(list) };
  return self;
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: "a1", role: "admin" });
});

// BP-326: every task-returning route publishes execution the same way
describe("GET /api/tasks/mine", () => {
  it("does not publish a held task's run id", async () => {
    taskFind.mockReturnValue(
      rows([
        {
          _id: "t1",
          title: "Mine and running",
          status: "in_progress",
          project: { name: "P", key: "TP", columns: [] },
          execution: { runId: "run-secret-123", workerId: "w1", attempts: 1, phaseSeq: 3 },
        },
      ])
    );

    const res = await GET(new Request("http://localhost/api/tasks/mine"), {
      params: Promise.resolve({}),
    });
    const text = await res.text();

    expect(text).toContain("Mine and running");
    expect(text).not.toContain("run-secret-123");
  });
});
