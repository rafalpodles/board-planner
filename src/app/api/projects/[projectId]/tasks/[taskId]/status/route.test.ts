import { describe, it, expect, vi, beforeEach } from "vitest";

const changeStatus = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/task-service", () => ({ changeStatus }));
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
  it("refuses force from a machine credential", async () => {
    const res = await PATCH(request({ status: "todo", force: true }, "worker"), ctx());

    expect(res.status).toBe(403);
    expect(changeStatus).not.toHaveBeenCalled();
  });

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

  it("does not take a worker id from a header the middleware never verified", async () => {
    const forged = new Request("https://app.example.com/api/projects/p1/tasks/t1/status", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-worker-id": "w1" },
      body: JSON.stringify({ status: "in_review" }),
    });

    const res = await PATCH(forged, ctx());

    expect(res.status).toBe(200);
    expect(changeStatus).toHaveBeenCalledWith("p1", "t1", "in_review", "u1", {
      force: false,
      workerId: undefined,
    });
  });

  it("gives an API token no worker id", async () => {
    await PATCH(request({ status: "in_review" }, "machineToken"), ctx());

    expect(changeStatus).toHaveBeenCalledWith("p1", "t1", "in_review", "u1", {
      force: false,
      workerId: undefined,
    });
  });
});
