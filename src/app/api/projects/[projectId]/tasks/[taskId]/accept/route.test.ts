import { describe, it, expect, vi, beforeEach } from "vitest";

const acceptHandover = vi.fn();

vi.mock("@/lib/task-service", () => ({ acceptHandover }));
vi.mock("@/lib/task-execution-view", () => ({ withApiExecution: async (_db: unknown, task: unknown) => task }));
// A Bearer is a machine credential, a cookie session is a person — the same shape the decision
// route's test models, so the refusal below is judged on the flag the real middleware sets
vi.mock("@/lib/middleware", () => ({
  withProjectAccess:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: unknown) =>
      handler(req, {
        ...(ctx as object),
        user: {
          _id: "u-bartek",
          username: "bartek",
          viaMachineCredential: (req.headers.get("authorization") ?? "").startsWith("Bearer "),
        },
        db: { organisation: "o1" },
      }),
}));

const { POST, ACCEPT_NEEDS_A_PERSON } = await import("./route");

const TASK_ID = "69a52e3b399b27d3cbb2c5b7";

function post(taskId = TASK_ID, asMachine = false) {
  const req = new Request(`https://app.example.com/api/projects/p1/tasks/${taskId}/accept`, {
    method: "POST",
    headers: asMachine ? { authorization: "Bearer cp_x" } : {},
  });
  return POST(req, { params: Promise.resolve({ projectId: "p1", taskId }) });
}

beforeEach(() => acceptHandover.mockReset());

describe("POST /api/projects/:projectId/tasks/:taskId/accept", () => {
  it("accepts as the person in the session", async () => {
    acceptHandover.mockResolvedValue({ ok: true, data: { _id: TASK_ID, taskNumber: 5 } });

    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ _id: TASK_ID, taskNumber: 5 });
    expect(acceptHandover).toHaveBeenCalledWith({ organisation: "o1" }, "p1", TASK_ID, "u-bartek");
  });

  it("refuses every machine credential before anything is read", async () => {
    const res = await post(TASK_ID, true);

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(ACCEPT_NEEDS_A_PERSON);
    expect(acceptHandover).not.toHaveBeenCalled();
  });

  it("passes the service's refusal through with its status", async () => {
    acceptHandover.mockResolvedValue({ ok: false, error: "only the assignee", status: 403 });

    const res = await post();

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("only the assignee");
  });

  it("refuses a task id that is not one", async () => {
    const res = await post("nope");

    expect(res.status).toBe(400);
    expect(acceptHandover).not.toHaveBeenCalled();
  });
});
