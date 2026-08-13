import { ApiCustomField, ApiTask } from "@/types";

export function estimateOf(task: ApiTask, fieldId: string): number {
  const raw = task.customFieldValues?.[fieldId];
  if (typeof raw !== "number" && typeof raw !== "string") return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function sumEstimates(tasks: ApiTask[], fieldId: string): number {
  return tasks.reduce((sum, t) => sum + estimateOf(t, fieldId), 0);
}

// Rounds for display only — never feed this back into anything that stores or sums.
export function roundForDisplay(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
}

type HasCustomFields = { customFields?: ApiCustomField[] | null };

export function estimateFieldName(
  project: HasCustomFields | null | undefined,
  fieldId: string
): string {
  return project?.customFields?.find((f) => f._id === fieldId)?.name ?? "";
}
