import { describe, it, expect, vi, beforeEach } from "vitest";

const changeStatus = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/task-service", () => ({ changeStatus }));
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

const { PATCH } = await import("./route");

type Principal = "person" | "machineToken" | "worker";

function headersFor(principal: Principal): Record<string, string> {
  if (principal === "worker") return { authorization: "Bearer cpw_x", "x-worker-id": "w1" };
  if (principal === "machineToken") return { authorization: "Bearer cp_x" };
  return {};
}

function request(body: unknown, principal: Principal = "person") {
  return new Request("https://app.example.com/api/projects/p1/tasks/t1/status", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headersFor(principal) },
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ projectId: "p1", taskId: "t1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  changeStatus.mockResolvedValue({ ok: true, data: { _id: "t1" } });
});

describe("PATCH .../tasks/:taskId/status", () => {
  // BP-305: force was read from the body regardless of principal, so a worker credential
  // could take a task off another machine mid-run. CLAUDE.md already records the principle
  // for the PM agent: an unattended agent must not take work off a machine.
  it("refuses force from a machine credential", async () => {
    const res = await PATCH(request({ status: "todo", force: true }, "worker"), ctx());

    expect(res.status).toBe(403);
    expect(changeStatus).not.toHaveBeenCalled();
  });

  // BP-335: the hold refused the holder's own report, so every worker success path 409'd
  it("hands the verified worker id down so the holder is not refused its own report", async () => {
    const res = await PATCH(request({ status: "in_review" }, "worker"), ctx());

    expect(res.status).toBe(200);
    expect(changeStatus).toHaveBeenCalledWith("p1", "t1", "in_review", "u1", {
      force: false,
      workerId: "w1",
    });
  });

  it("leaves a person's force alone — it is how the board takes a task back", async () => {
    const res = await PATCH(request({ status: "todo", force: true }), ctx());

    expect(res.status).toBe(200);
    expect(changeStatus).toHaveBeenCalledWith("p1", "t1", "todo", "u1", {
      force: true,
      workerId: undefined,
    });
  });
});
