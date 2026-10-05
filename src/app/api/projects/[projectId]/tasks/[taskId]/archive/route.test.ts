import { describe, it, expect, vi, beforeEach } from "vitest";

const archiveTask = vi.fn();
const unarchiveTask = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/task-archive-service", () => ({ archiveTask, unarchiveTask }));
vi.mock("@/lib/task-execution-view", () => ({ withApiExecution: async (_db: unknown, task: unknown) => task }));
vi.mock("@/lib/middleware", async () => {
  const { scopedToDefaultOrganisation } = await vi.importActual<typeof import("@/lib/db-scope")>("@/lib/db-scope");
  return {
    withProjectAccess:
      (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
      (req: Request, ctx: unknown) =>
        handler(req, {
          ...(ctx as object),
          user: { _id: "u1", role: "member", viaMachineCredential: req.headers.get("x-machine") !== null },
          db: scopedToDefaultOrganisation(),
        }),
  };
});

const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
const { POST, DELETE } = await import("./route");

const TASK = "507f1f77bcf86cd799439011";
const ctx = () => ({ params: Promise.resolve({ projectId: "p1", taskId: TASK }) });

function call(method: "POST" | "DELETE", body?: unknown, asMachine = false) {
  return new Request(`https://app.example.com/api/projects/p1/tasks/${TASK}/archive`, {
    method,
    headers: { "content-type": "application/json", ...(asMachine ? { "x-machine": "1" } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const HELD = {
  ok: false as const,
  error: "BP-7 is being executed by mac (phase agent). Stop the worker, or archive it anyway to take the task from it.",
  status: 409,
  runConflict: { workerId: "w1", workerName: "mac", phase: "agent", phaseAt: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  archiveTask.mockResolvedValue({ ok: true, data: { _id: TASK, archivedAt: "2026-10-05" } });
  unarchiveTask.mockResolvedValue({ ok: true, data: { _id: TASK, archivedAt: null } });
});

describe("POST .../tasks/:taskId/archive", () => {
  it("archives for a member, with no body at all", async () => {
    const res = await POST(call("POST"), ctx());

    expect(res.status).toBe(200);
    expect((await res.json()).archivedAt).toBeTruthy();
    expect(archiveTask).toHaveBeenCalledWith(scopedToDefaultOrganisation(), "p1", TASK, "u1", false);
  });

  it("answers a held task with the 409 and its runConflict, as the other writers do", async () => {
    archiveTask.mockResolvedValue(HELD);

    const res = await POST(call("POST"), ctx());

    expect(res.status).toBe(409);
    expect((await res.json()).runConflict).toMatchObject({ workerName: "mac", phase: "agent" });
  });

  it("passes a person's force on", async () => {
    await POST(call("POST", { force: true }), ctx());

    expect(archiveTask).toHaveBeenCalledWith(expect.anything(), "p1", TASK, "u1", true);
  });

  it("treats a force that is not literally true as none", async () => {
    await POST(call("POST", { force: "yes" }), ctx());

    expect(archiveTask).toHaveBeenCalledWith(expect.anything(), "p1", TASK, "u1", false);
  });

  it("refuses force from a machine credential without reading the task", async () => {
    const res = await POST(call("POST", { force: true }, true), ctx());

    expect(res.status).toBe(403);
    expect(archiveTask).not.toHaveBeenCalled();
  });

  it("lets a machine credential archive without force", async () => {
    const res = await POST(call("POST", undefined, true), ctx());

    expect(res.status).toBe(200);
    expect(archiveTask).toHaveBeenCalled();
  });

  it("passes a missing task on as 404", async () => {
    archiveTask.mockResolvedValue({ ok: false, error: "Task not found", status: 404 });

    expect((await POST(call("POST"), ctx())).status).toBe(404);
  });
});

describe("DELETE .../tasks/:taskId/archive (restore)", () => {
  it("restores for a member", async () => {
    const res = await DELETE(call("DELETE"), ctx());

    expect(res.status).toBe(200);
    expect(unarchiveTask).toHaveBeenCalledWith(scopedToDefaultOrganisation(), "p1", TASK, "u1");
  });

  it("passes a missing task on as 404", async () => {
    unarchiveTask.mockResolvedValue({ ok: false, error: "Task not found", status: 404 });

    expect((await DELETE(call("DELETE"), ctx())).status).toBe(404);
  });
});
