import { describe, it, expect, vi, beforeEach } from "vitest";

const updateTask = vi.fn();
const createTask = vi.fn();
vi.mock("@/lib/task-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/task-service")>()),
  updateTask: (...args: unknown[]) => updateTask(...args),
  createTask: (...args: unknown[]) => createTask(...args),
}));

const { PM_TOOLS } = await import("./tools");

// BP-1066. The PM names a task's repository the way a person does, by name, and the board's own list
// decides what that means.
describe("the PM agent naming a task's repository", () => {
  const ctx = { projectId: "p1", projectKey: "BP", pmUserId: "pm" } as never;
  const repositories = [
    { _id: "r1", url: "https://github.com/acme/app", name: "App" },
    { _id: "r2", url: "https://github.com/acme/site", name: "" },
  ];
  const db = {
    Project: { findById: () => ({ lean: async () => ({ repositories }) }) },
    Task: { findOne: async () => ({ _id: "t1", checklist: [] }) },
  } as never;

  beforeEach(() => {
    updateTask.mockReset();
    createTask.mockReset();
    updateTask.mockResolvedValue({ ok: true, data: { taskNumber: 1 } });
    createTask.mockResolvedValue({ ok: true, data: { taskNumber: 2, title: "T", status: "backlog" } });
  });

  it("offers the parameter on create_task and update_task", () => {
    for (const name of ["create_task", "update_task"]) {
      expect(PM_TOOLS[name].definition.parameters.properties).toHaveProperty("repository");
    }
  });

  it("creates a task with the repository resolved by name to its id", async () => {
    await PM_TOOLS.create_task.execute(db, { title: "T", repository: "app" }, ctx);

    expect(createTask.mock.calls[0][3]).toMatchObject({ repository: "r1" });
  });

  it("updates a task's repository by address, and clears it on an empty string", async () => {
    await PM_TOOLS.update_task.execute(db, { taskKey: "BP-1", repository: "https://github.com/acme/site" }, ctx);
    await PM_TOOLS.update_task.execute(db, { taskKey: "BP-1", repository: "" }, ctx);

    expect(updateTask.mock.calls[0][3]).toEqual({ repository: "r2" });
    expect(updateTask.mock.calls[1][3]).toEqual({ repository: null });
  });

  it("answers an unknown repository with the board's list instead of writing", async () => {
    const created = await PM_TOOLS.create_task.execute(db, { title: "T", repository: "nope" }, ctx);
    const updated = await PM_TOOLS.update_task.execute(db, { taskKey: "BP-1", repository: "nope" }, ctx);

    for (const answer of [created, updated]) {
      expect(answer.result).toEqual({ error: expect.stringContaining("r1") });
    }
    expect(createTask).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("leaves the repository out of the write when the call does not mention it", async () => {
    await PM_TOOLS.update_task.execute(db, { taskKey: "BP-1", title: "renamed" }, ctx);
    await PM_TOOLS.create_task.execute(db, { title: "T" }, ctx);

    expect(updateTask.mock.calls[0][3]).not.toHaveProperty("repository");
    expect(createTask.mock.calls[0][3]).not.toHaveProperty("repository");
  });
});
