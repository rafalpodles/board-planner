import {
  ApiCustomField,
  ApiProjectCategory,
  ApiTask,
  DEFAULT_PRIORITY,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
} from "@/types";
import { AnyColumn, effectiveColumns } from "./columns";
import { activeFields, orderedOptions } from "./custom-fields";

export const GROUP_BY_BUILT_INS = ["assignee", "priority", "category", "status"] as const;

export type GroupBy = "" | (typeof GROUP_BY_BUILT_INS)[number] | `field:${string}`;

export const FIELD_GROUP_PREFIX = "field:";
export const NONE_GROUP = "@none";
export const UNFILED_GROUP = "@unfiled";

export interface TaskGroup {
  key: string;
  label: string;
  color?: string;
  tasks: ApiTask[];
}

export interface GroupContext {
  columns?: AnyColumn[] | null;
  categories?: ApiProjectCategory[];
  customFields?: ApiCustomField[];
}

const BUILT_IN_LABELS: Record<(typeof GROUP_BY_BUILT_INS)[number], string> = {
  assignee: "Assignee",
  priority: "Priority",
  category: "Category",
  status: "Status",
};

function groupableFields(customFields: ApiCustomField[]): ApiCustomField[] {
  return activeFields(customFields).filter((f) => f.fieldType === "dropdown");
}

export function groupByOptions(customFields: ApiCustomField[] = []): { value: GroupBy; label: string }[] {
  return [
    { value: "", label: "No grouping" },
    ...GROUP_BY_BUILT_INS.map((value) => ({ value, label: BUILT_IN_LABELS[value] })),
    ...groupableFields(customFields).map((f) => ({
      value: `${FIELD_GROUP_PREFIX}${f._id}` as GroupBy,
      label: f.name,
    })),
  ];
}

export function sanitizeGroupBy(raw: unknown, customFields: ApiCustomField[] = []): GroupBy {
  if (typeof raw !== "string") return "";
  return groupByOptions(customFields).some((o) => o.value === raw) ? (raw as GroupBy) : "";
}

export function groupByLabel(groupBy: GroupBy, customFields: ApiCustomField[] = []): string {
  return groupByOptions(customFields).find((o) => o.value === groupBy)?.label ?? "";
}

type Bucket = { key: string; label: string; color?: string; rank: number; tasks: ApiTask[] };

const LAST = Number.MAX_SAFE_INTEGER;

export const valueKey = (value: string) => `v:${value}`;

/**
 * Splits already-sorted tasks into ordered groups. Tasks keep their relative order inside a group,
 * empty groups are not returned, and the "none" and "unfiled" groups come last.
 */
export function groupTasks(tasks: ApiTask[], groupBy: GroupBy, ctx: GroupContext = {}): TaskGroup[] {
  if (!groupBy) return [];
  const buckets = new Map<string, Bucket>();

  function add(task: ApiTask, key: string, label: string, rank: number, color?: string) {
    const bucket = buckets.get(key);
    if (bucket) bucket.tasks.push(task);
    else buckets.set(key, { key, label, color, rank, tasks: [task] });
  }

  switch (groupBy) {
    case "status": {
      const columns = effectiveColumns(ctx.columns);
      const byId = new Map(columns.map((c, i) => [c.id, { column: c, rank: i }]));
      for (const task of tasks) {
        const hit = byId.get(task.status);
        if (hit) add(task, valueKey(task.status), hit.column.label, hit.rank, hit.column.color);
        else add(task, UNFILED_GROUP, "No column", LAST);
      }
      break;
    }
    case "priority": {
      for (const task of tasks) {
        const priority = task.priority || DEFAULT_PRIORITY;
        const label = PRIORITY_LABELS[priority] ?? priority;
        add(task, valueKey(priority), label, PRIORITY_ORDER[priority] ?? LAST - 1);
      }
      break;
    }
    case "assignee": {
      for (const task of tasks) {
        const person = task.assignee && typeof task.assignee === "object" ? task.assignee : null;
        if (person) add(task, valueKey(person.username), person.fullName || person.username, 0);
        else add(task, NONE_GROUP, "Unassigned", LAST);
      }
      break;
    }
    case "category": {
      const rankByName = new Map((ctx.categories ?? []).map((c, i) => [c.name, { rank: i, color: c.color }]));
      for (const task of tasks) {
        if (!task.category) {
          add(task, NONE_GROUP, "No category", LAST);
          continue;
        }
        const known = rankByName.get(task.category);
        add(task, valueKey(task.category), task.category, known?.rank ?? LAST - 1, known?.color);
      }
      break;
    }
    default: {
      const field = groupableFields(ctx.customFields ?? []).find(
        (f) => `${FIELD_GROUP_PREFIX}${f._id}` === groupBy
      );
      if (!field) return [];
      const options = new Map(orderedOptions(field).map((o, i) => [o.id, { option: o, rank: i }]));
      for (const task of tasks) {
        const raw = task.customFieldValues?.[field._id];
        const hit = typeof raw === "string" ? options.get(raw) : undefined;
        if (hit) add(task, valueKey(hit.option.id), hit.option.value, hit.rank, hit.option.color);
        else add(task, NONE_GROUP, `No ${field.name}`, LAST);
      }
    }
  }

  return [...buckets.values()]
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
    .map(({ key, label, color, tasks: members }) => ({ key, label, color, tasks: members }));
}

export function flattenGroups(groups: TaskGroup[], collapsed?: ReadonlySet<string>): ApiTask[] {
  return groups.flatMap((g) => (collapsed?.has(g.key) ? [] : g.tasks));
}
