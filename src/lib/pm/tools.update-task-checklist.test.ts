import { describe, it, expect, vi, beforeEach } from "vitest";

const updateTask = vi.fn();
vi.mock("@/lib/task-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/task-service")>()),
  updateTask: (...args: unknown[]) => updateTask(...args),
}));

const { PM_TOOLS } = await import("./tools");

/**
 * BP-908. The PM agent's `update_task` was the third place that wrote a whole checklist from a
 * markdown string, and it had the same defect as the MCP tool: every criterion minted anew, every
 * plain line read as unticked.
 */
describe("the PM agent's update_task and a checklist it is handed as text", () => {
  const A = "507f1f77bcf86cd799439011";
  const B = "507f1f77bcf86cd799439012";
  const ctx = { projectId: "p1", projectKey: "BP", pmUserId: "pm" } as never;

  beforeEach(() => {
    updateTask.mockReset();
    updateTask.mockResolvedValue({ ok: true, data: { taskNumber: 1 } });
  });

  const run = (acceptanceCriteria: string) => {
    const db = {
      Task: {
        findOne: async () => ({
          _id: "t1",
          checklist: [
            { _id: A, text: "first", done: true },
            { _id: B, text: "second", done: false },
          ],
        }),
      },
    };
    return PM_TOOLS.update_task.execute(db as never, { taskKey: "BP-1", acceptanceCriteria }, ctx);
  };

  it("keeps the id and the tick of a line whose text is unchanged, and sends a list rather than the text", async () => {
    await run("first\nsecond, reworded");

    const body = updateTask.mock.calls[0][3];
    expect(body).not.toHaveProperty("acceptanceCriteria");
    expect(body.checklist).toEqual([
      { _id: A, text: "first", done: true },
      { text: "second, reworded", done: false },
    ]);
  });

  it("still lets a line state its own box", async () => {
    await run("- [ ] first\n- [x] second");

    expect(updateTask.mock.calls[0][3].checklist).toEqual([
      { _id: A, text: "first", done: false },
      { _id: B, text: "second", done: true },
    ]);
  });
});
