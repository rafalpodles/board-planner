import { describe, it, expect } from "vitest";
import { duplicatePayload, undoneChecklist } from "./task-duplicate";
import { ApiTask } from "@/types";

const task = {
  title: "Water the plants",
  description: "Every window sill",
  priority: "urgent",
  category: "bug",
  checklist: [
    { _id: "c1", text: "First criterion", done: true },
    { _id: "c2", text: "Second criterion", done: false },
  ],
  dueDate: "2026-05-12T12:00:00.000Z",
  customFieldValues: { f1: "L" },
  recurrence: { frequency: "weekly", interval: 2 },
} as unknown as ApiTask;

describe("duplicatePayload", () => {
  it("carries the definition of the work, the rhythm and the priority included", () => {
    expect(duplicatePayload(task)).toMatchObject({
      title: "Copy of Water the plants",
      description: "Every window sill",
      priority: "urgent",
      category: "bug",
      dueDate: "2026-05-12T12:00:00.000Z",
      customFieldValues: { f1: "L" },
      recurrence: { frequency: "weekly", interval: 2 },
    });
  });

  it("hands over work to do rather than work half done", () => {
    expect(duplicatePayload(task).checklist).toEqual([
      { text: "First criterion", done: false },
      { text: "Second criterion", done: false },
    ]);
  });

  it("clamps the copy's title to the cap instead of letting the prefix push it over", () => {
    const longTitle = "A".repeat(193);
    const payload = duplicatePayload({ ...task, title: longTitle } as unknown as ApiTask);
    expect(payload.title).toHaveLength(200);
    expect(payload.title).toBe(`Copy of ${longTitle}`.slice(0, 200));
  });

  it("drops a trailing lone surrogate instead of a mangled character", () => {
    const longTitle = `${"A".repeat(191)}😀${"A".repeat(10)}`;
    const payload = duplicatePayload({ ...task, title: longTitle } as unknown as ApiTask);
    expect(payload.title).toBe(`Copy of ${"A".repeat(191)}`);
    expect(payload.title.charCodeAt(payload.title.length - 1)).toBeLessThan(0xd800);
  });

  it("names neither the status, the assignee, the sprint nor the agent", () => {
    const payload = duplicatePayload({
      ...task,
      assignee: { _id: "u1", username: "rpo" },
      sprint: "s1",
      agent: { _id: "a1", name: "Default" },
    } as unknown as ApiTask);

    for (const field of ["status", "assignee", "sprint", "agent"]) {
      expect(payload).not.toHaveProperty(field);
    }
  });
});

describe("undoneChecklist", () => {
  it("takes the items' own ids with the ticks", () => {
    const stored = [{ _id: "c1", text: "One", done: true }];
    expect(undoneChecklist(stored)).toEqual([{ text: "One", done: false }]);
  });

  it("answers an empty list for a task that has no criteria at all", () => {
    expect(undoneChecklist(undefined)).toEqual([]);
    expect(undoneChecklist(null)).toEqual([]);
  });
});
