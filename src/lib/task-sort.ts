import { ApiCustomField, ApiSprint, ApiTask, PRIORITY_ORDER, SortDir, SortField } from "@/types";
import { normalizeOptions } from "./custom-fields";

export interface SortContext {
  statusOrder?: Map<string, number>;
  sprintById?: Map<string, ApiSprint>;
  fieldById?: Map<string, ApiCustomField>;
}

function fieldValue(task: ApiTask, fieldId: string): unknown {
  return task.customFieldValues?.[fieldId];
}

export function isEmptyFieldValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function compareFieldValues(a: unknown, b: unknown, field: ApiCustomField): number {
  switch (field.fieldType) {
    case "number":
      return Number(a) - Number(b);
    case "date":
      return new Date(String(a)).getTime() - new Date(String(b)).getTime();
    case "checkbox":
      return Number(!!a) - Number(!!b);
    case "dropdown":
    case "multiselect": {
      const order = new Map(normalizeOptions(field.options).map((o) => [o.id, o.order ?? 0]));
      const rank = (value: unknown) => {
        const first = Array.isArray(value) ? (value[0] as string) : (value as string);
        return order.get(first) ?? Number.MAX_SAFE_INTEGER;
      };
      return rank(a) - rank(b);
    }
    default:
      return String(a).localeCompare(String(b));
  }
}

function assigneeName(task: ApiTask): string {
  return task.assignee && typeof task.assignee === "object" ? task.assignee.fullName : "";
}

function compare(a: ApiTask, b: ApiTask, field: string, ctx: SortContext): number {
  const definition = ctx.fieldById?.get(field);
  if (definition) {
    return compareFieldValues(fieldValue(a, field), fieldValue(b, field), definition);
  }
  switch (field as SortField) {
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
    case "category":
      return a.category.localeCompare(b.category);
    case "dueDate": {
      const at = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
      const bt = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
      return at === bt ? 0 : at - bt;
    }
    case "updatedAt":
    case "createdAt": {
      const key = field as "updatedAt" | "createdAt";
      return new Date(a[key]).getTime() - new Date(b[key]).getTime();
    }
    default:
      return 0;
  }
}

export function sortTasks(
  tasks: ApiTask[],
  field: string,
  dir: SortDir,
  ctx: SortContext = {}
): ApiTask[] {
  const sign = dir === "asc" ? 1 : -1;
  const definition = ctx.fieldById?.get(field);

  function emptiesLast(a: ApiTask, b: ApiTask): number {
    if (!definition) return 0;
    const emptyA = isEmptyFieldValue(fieldValue(a, field));
    const emptyB = isEmptyFieldValue(fieldValue(b, field));
    if (emptyA === emptyB) return 0;
    return emptyA ? 1 : -1;
  }
  return [...tasks].sort(
    (a, b) => emptiesLast(a, b) || compare(a, b, field, ctx) * sign || a.taskNumber - b.taskNumber
  );
}
