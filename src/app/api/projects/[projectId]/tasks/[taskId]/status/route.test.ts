import { describe, it, expect, vi, beforeEach } from "vitest";

const changeStatus = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/task-service", () => ({ changeStatus }));
vi.mock("@/lib/middleware", () => ({
  withProjectAccessOrWorker:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: unknown) =>
      handler(req, {
        ...(ctx as object),
        user: { _id: "u1", viaMachineCredential: req.headers.get("x-worker-id") !== null },
      }),
}));

const { PATCH } = await import("./route");

function request(body: unknown, asWorker = false) {
  return new Request("https://app.example.com/api/projects/p1/tasks/t1/status", {
    method: "PATCH",
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
  changeStatus.mockResolvedValue({ ok: true, data: { _id: "t1" } });
});

describe("PATCH .../tasks/:taskId/status", () => {
  // BP-305: force was read from the body regardless of principal, so a worker credential
  // could take a task off another machine mid-run. CLAUDE.md already records the principle
  // for the PM agent: an unattended agent must not take work off a machine.
  it("refuses force from a machine credential", async () => {
    const res = await PATCH(request({ status: "todo", force: true }, true), ctx());

    expect(res.status).toBe(403);
    expect(changeStatus).not.toHaveBeenCalled();
  });

  it("still lets a worker move a task it is not forcing", async () => {
    const res = await PATCH(request({ status: "in_review" }, true), ctx());

    expect(res.status).toBe(200);
    expect(changeStatus).toHaveBeenCalledWith("p1", "t1", "in_review", "u1", false);
  });

  it("leaves a person's force alone — it is how the board takes a task back", async () => {
    const res = await PATCH(request({ status: "todo", force: true }), ctx());

    expect(res.status).toBe(200);
    expect(changeStatus).toHaveBeenCalledWith("p1", "t1", "todo", "u1", true);
  });
});
