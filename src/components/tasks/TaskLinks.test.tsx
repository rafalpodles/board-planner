// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TaskLinks } from "./TaskLinks";
import { ApiTask, ApiTaskLink } from "@/types";

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-open-task", () => ({ useOpenTask: () => vi.fn() }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

function linked(id: string, taskNumber: number, title = `Task ${taskNumber}`): ApiTaskLink {
  return { _id: id, taskNumber, title, status: "todo" };
}

function baseTask(overrides: Partial<ApiTask> = {}): ApiTask {
  return {
    _id: "self",
    project: "p1",
    taskKey: "TP-1",
    taskNumber: 1,
    title: "The task under test",
    description: "",
    priority: "medium",
    category: "bug",
    status: "todo",
    assignee: null,
    dueDate: null,
    checklist: [],
    linkedPRs: [],
    blockedBy: [],
    blocking: [],
    relations: [],
    relatedFrom: [],
    watchers: [],
    sprint: null,
    customFieldValues: {},
    recurrence: null,
    createdBy: { _id: "u1", username: "rafal", fullName: "Rafal" },
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  } as ApiTask;
}

beforeEach(() => {
  api.get.mockReset();
  api.del.mockReset();
  api.del.mockResolvedValue({});
});

afterEach(cleanup);

// BP-657: an incoming "Relates to" row is stored on the OTHER task's document, and asking this
// task's own endpoint to drop it was a no-op the toast still called a success.
describe("removing an incoming Relates to link", () => {
  it("addresses the DELETE to the end that actually holds the relation", async () => {
    const other = linked("other", 3, "The other task");
    const task = baseTask({ relatedFrom: [{ task: other, type: "relates" }] });
    render(
      <TaskLinks projectId="p1" projectKey="TP" task={task} onChanged={() => {}} />
    );

    fireEvent.click(screen.getByRole("button", { name: /unlink tp-3/i }));

    expect(api.del).toHaveBeenCalledWith("/api/projects/p1/tasks/other/links", {
      taskId: "self",
      type: "relates",
    });
  });

  it("still addresses the DELETE to this task for an outgoing Relates to link", async () => {
    const other = linked("other", 3, "The other task");
    const task = baseTask({ relations: [{ task: other, type: "relates" }] });
    render(
      <TaskLinks projectId="p1" projectKey="TP" task={task} onChanged={() => {}} />
    );

    fireEvent.click(screen.getByRole("button", { name: /unlink tp-3/i }));

    expect(api.del).toHaveBeenCalledWith("/api/projects/p1/tasks/self/links", {
      taskId: "other",
      type: "relates",
    });
  });
});

// BP-657 checklist: a pair linked from both directions must render once, not twice with a
// colliding React key.
describe("a pair related from both directions", () => {
  it("renders one row under Relates to, not two", () => {
    const other = linked("other", 3, "The other task");
    const task = baseTask({
      relations: [{ task: other, type: "relates" }],
      relatedFrom: [{ task: other, type: "relates" }],
    });
    render(
      <TaskLinks projectId="p1" projectKey="TP" task={task} onChanged={() => {}} />
    );

    expect(screen.getAllByText("TP-3")).toHaveLength(1);
  });

  // Review finding: removing only the displayed (outgoing) copy left the incoming one in place,
  // and the row reappeared from that surviving direction after the refetch — reporting a removal
  // that only half happened, the same symptom this ticket was filed for in the first place.
  it("removes both directions, not just the one displayed", () => {
    const other = linked("other", 3, "The other task");
    const task = baseTask({
      relations: [{ task: other, type: "relates" }],
      relatedFrom: [{ task: other, type: "relates" }],
    });
    render(
      <TaskLinks projectId="p1" projectKey="TP" task={task} onChanged={() => {}} />
    );

    fireEvent.click(screen.getByRole("button", { name: /unlink tp-3/i }));

    expect(api.del).toHaveBeenCalledWith("/api/projects/p1/tasks/self/links", {
      taskId: "other",
      type: "relates",
    });
    expect(api.del).toHaveBeenCalledWith("/api/projects/p1/tasks/other/links", {
      taskId: "self",
      type: "relates",
    });
    expect(api.del).toHaveBeenCalledTimes(2);
  });
});

// BP-691: the picker used to offer a task that already relates to this one from the other end,
// and adding it there stored a second, mirrored relation.
describe("the add-dependency picker", () => {
  async function openPicker(task: ApiTask, tasks: unknown[]) {
    api.get.mockResolvedValue(tasks);
    render(
      <TaskLinks projectId="p1" projectKey="TP" task={task} onChanged={() => {}} />
    );
    fireEvent.click(screen.getByRole("button", { name: "+ Add dependency" }));
    // The list loads from an effect keyed on the picker opening
    await screen.findByRole("textbox", { name: /search tasks to link/i });
  }

  it("does not offer a task this one already relates to from the other end", async () => {
    const relatedFromOther = linked("x", 3, "Related from X");
    const task = baseTask({ relatedFrom: [{ task: relatedFromOther, type: "relates" }] });
    await openPicker(task, [
      { _id: "x", taskNumber: 3, title: "Related from X", status: "todo" },
      { _id: "y", taskNumber: 4, title: "Not linked yet", status: "todo" },
    ]);

    // The title also renders in the "Relates to" row above the picker, in a plain span — only the
    // picker's own entries are actual buttons, so scoping by role is what tells the two apart.
    expect(screen.queryByRole("button", { name: /related from x/i })).toBeNull();
    expect(screen.getByRole("button", { name: /not linked yet/i })).toBeTruthy();
  });

  // Documented decision (BP-691): "duplicates" is not folded in — the two directions are
  // different claims, not the same relation stored twice.
  it("still offers a task that duplicates this one from the other end", async () => {
    const duplicatedByOther = linked("x", 3, "Duplicates this one");
    const task = baseTask({ relatedFrom: [{ task: duplicatedByOther, type: "duplicates" }] });
    await openPicker(task, [
      { _id: "x", taskNumber: 3, title: "Duplicates this one", status: "todo" },
    ]);

    expect(screen.getByRole("button", { name: /duplicates this one/i })).toBeTruthy();
  });
});
