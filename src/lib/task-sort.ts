import { ApiSprint, ApiTask, PRIORITY_ORDER, SortDir, SortField } from "@/types";

const DIFFICULTY_ORDER: Record<string, number> = { S: 0, M: 1, L: 2, XL: 3 };

export interface SortContext {
  /** Board columns in board order — the only sensible ordering for a status */
  statusOrder?: Map<string, number>;
  sprintById?: Map<string, ApiSprint>;
}

function assigneeName(task: ApiTask): string {
  return task.assignee && typeof task.assignee === "object" ? task.assignee.fullName : "";
}

function compare(a: ApiTask, b: ApiTask, field: SortField, ctx: SortContext): number {
  switch (field) {
    // Mirrors the API's own ordering, so drag-and-drop reordering survives
    case "manual":
      return (
        (a.order ?? 0) - (b.order ?? 0) ||
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    case "key":
      return a.taskNumber - b.taskNumber;
    case "title":
      return a.title.localeCompare(b.title);
    case "status":
      return (
        (ctx.statusOrder?.get(a.status) ?? 99) - (ctx.statusOrder?.get(b.status) ?? 99)
      );
    case "assignee":
      return assigneeName(a).localeCompare(assigneeName(b));
    case "priority":
      return (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
    case "sprint": {
      const start = (task: ApiTask) => {
        const sprint = task.sprint ? ctx.sprintById?.get(task.sprint) : undefined;
        return sprint ? new Date(sprint.startDate).getTime() : Number.MAX_SAFE_INTEGER;
      };
      return start(a) - start(b);
    }
    case "difficulty":
      return (DIFFICULTY_ORDER[a.difficulty] ?? 99) - (DIFFICULTY_ORDER[b.difficulty] ?? 99);
    case "category":
      return a.category.localeCompare(b.category);
    case "component":
      return (a.component || "").localeCompare(b.component || "");
    // Undated sorts last ascending, which is what "soonest first" means
    case "dueDate": {
      const at = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
      const bt = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
      return at === bt ? 0 : at - bt;
    }
    case "updatedAt":
    case "createdAt":
      return new Date(a[field]).getTime() - new Date(b[field]).getTime();
  }
}

export function sortTasks(
  tasks: ApiTask[],
  field: SortField,
  dir: SortDir,
  ctx: SortContext = {}
): ApiTask[] {
  const sign = dir === "asc" ? 1 : -1;
  // Task number is a stable, always-present tiebreak; without it equal keys make
  // the order jitter between renders
  return [...tasks].sort(
    (a, b) => compare(a, b, field, ctx) * sign || a.taskNumber - b.taskNumber
  );
}
