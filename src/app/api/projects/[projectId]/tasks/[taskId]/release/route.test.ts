import { describe, it, expect, vi, beforeEach } from "vitest";

const releaseTask = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/task-service", () => ({ releaseTask }));
// Models the real middleware rather than deriving one fact from another: the worker branch needs a
// Bearer AND x-worker-id and yields a verified workerId; a cp_/cpat_ token is a machine credential
// with NO verified worker id; a cookie session is a person. The old mock defined
// viaMachineCredential AS the presence of x-worker-id, which made the machine-without-header case —
// the one that turned out to be a hole — impossible to express (BP-336).
vi.mock("@/lib/middleware", () => ({
  withProjectAccessOrWorker:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: unknown) => {
      const bearer = (req.headers.get("authorization") ?? "").startsWith("Bearer ");
      const header = req.headers.get("x-worker-id");
      const asWorker = bearer && !!header;
      return handler(req, {
        ...(ctx as object),
        user: { _id: "u1", viaMachineCredential: bearer },
        ...(asWorker ? { workerId: header } : {}),
      });
    },
}));

const { POST } = await import("./route");

type Principal = "person" | "machineToken" | "worker";

function headersFor(principal: Principal): Record<string, string> {
  if (principal === "worker") return { authorization: "Bearer cpw_x", "x-worker-id": "w1" };
  if (principal === "machineToken") return { authorization: "Bearer cp_x" };
  return {};
}

function request(body: unknown, principal: Principal = "person") {
  return new Request("https://app.example.com/api/projects/p1/tasks/t1/release", {
    method: "POST",
    headers: { "content-type": "application/json", ...headersFor(principal) },
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
    const res = await POST(request({}, "worker"), ctx());

    expect(res.status).toBe(200);
    expect(releaseTask).toHaveBeenCalledWith("p1", "t1", { refund: true, workerId: "w1" });
  });

  it("keeps the scope on a no-refund release, which is the one that parks a task", async () => {
    await POST(request({ refund: false }, "worker"), ctx());

    expect(releaseTask).toHaveBeenCalledWith("p1", "t1", { refund: false, workerId: "w1" });
  });

  it("leaves a person's release broad — that button clears a stuck card", async () => {
    const res = await POST(request({}), ctx());

    expect(res.status).toBe(200);
    expect(releaseTask).toHaveBeenCalledWith("p1", "t1", { refund: true });
  });

  // The worker id is not self-asserted: the middleware verified the credential against it
  // BP-336: a cp_/cpat_ token is a machine credential that never carries x-worker-id, so keying
  // the scope on the header let it through to the broad release of whatever run held the task.
  it("refuses a machine credential that carries no verified worker id", async () => {
    const res = await POST(request({}, "machineToken"), ctx());

    expect(res.status).toBe(403);
    expect(releaseTask).not.toHaveBeenCalled();
  });

  it("refuses it on the no-refund path too, which is the one that parks a task", async () => {
    const res = await POST(request({ refund: false }, "machineToken"), ctx());

    expect(res.status).toBe(403);
    expect(releaseTask).not.toHaveBeenCalled();
  });

  it("takes the worker id from the middleware, not from the request", async () => {
    await POST(request({ workerId: "someone-else" }, "worker"), ctx());

    expect(releaseTask).toHaveBeenCalledWith("p1", "t1", { refund: true, workerId: "w1" });
  });
});
