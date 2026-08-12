import { describe, it, expect, vi, beforeEach } from "vitest";

const releaseTask = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/task-service", () => ({ releaseTask }));
vi.mock("@/lib/middleware", () => ({
  withProjectAccessOrWorker:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: unknown) =>
      handler(req, {
        ...(ctx as object),
        user: { _id: "u1", viaMachineCredential: req.headers.get("x-worker-id") !== null },
      }),
}));

const { POST } = await import("./route");

function request(body: unknown, asWorker = false) {
  return new Request("https://app.example.com/api/projects/p1/tasks/t1/release", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(asWorker ? { "x-worker-id": "w1" } : {}),
    },
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ projectId: "p1", taskId: "t1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  releaseTask.mockResolvedValue({ _id: "t1" });
});

// BP-305: releaseTask filtered on "held by SOME run", so worker A could release worker B's
// task mid-run — spending its attempt, or with refund:false parking it in escalation
describe("POST .../tasks/:taskId/release", () => {
  it("scopes a worker's release to the tasks it holds", async () => {
    const res = await POST(request({}, true), ctx());

    expect(res.status).toBe(200);
    expect(releaseTask).toHaveBeenCalledWith("p1", "t1", { refund: true, workerId: "w1" });
  });

  it("keeps the scope on a no-refund release, which is the one that parks a task", async () => {
    await POST(request({ refund: false }, true), ctx());

    expect(releaseTask).toHaveBeenCalledWith("p1", "t1", { refund: false, workerId: "w1" });
  });

  it("leaves a person's release broad — that button clears a stuck card", async () => {
    const res = await POST(request({}), ctx());

    expect(res.status).toBe(200);
    expect(releaseTask).toHaveBeenCalledWith("p1", "t1", { refund: true });
  });

  // The worker id is not self-asserted: the middleware verified the credential against it
  it("takes the worker id from the verified header, not from the body", async () => {
    await POST(request({ workerId: "someone-else" }, true), ctx());

    expect(releaseTask).toHaveBeenCalledWith("p1", "t1", { refund: true, workerId: "w1" });
  });
});
