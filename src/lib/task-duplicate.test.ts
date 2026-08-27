import { describe, it, expect } from "vitest";
import { duplicatePayload, undoneChecklist } from "./task-duplicate";
import { ApiTask } from "@/types";

// Everything a copy could carry is set, so a dropped field is a decision this test can see rather
// than a null the fixture never had
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

  // The three the product deliberately leaves behind, plus the status the server picks itself
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
  // The ids go too: checklistOrRefusal keeps one when it is sent, which left a copy's items
  // carrying the original task's subdocument ids
  it("takes the items' own ids with the ticks", () => {
    const stored = [{ _id: "c1", text: "One", done: true }];
    expect(undoneChecklist(stored)).toEqual([{ text: "One", done: false }]);
  });

  it("answers an empty list for a task that has no criteria at all", () => {
    expect(undoneChecklist(undefined)).toEqual([]);
    expect(undoneChecklist(null)).toEqual([]);
  });
});
