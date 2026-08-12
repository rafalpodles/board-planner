import { ApiTask } from "@/types";

export function estimateOf(task: ApiTask, fieldId: string): number {
  const raw = task.customFieldValues?.[fieldId];
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function sumEstimates(tasks: ApiTask[], fieldId: string): number {
  return tasks.reduce((sum, t) => sum + estimateOf(t, fieldId), 0);
}
