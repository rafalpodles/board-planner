import type { ApiEpicProgress } from "@/types";

export function tallyProgress(statuses: string[], doneStatuses: string[]): ApiEpicProgress {
  const done = new Set(doneStatuses);
  const byStatus: Record<string, number> = {};
  let finished = 0;
  for (const status of statuses) {
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (done.has(status)) finished++;
  }
  return { total: statuses.length, done: finished, byStatus };
}

export function progressLine(progress: Pick<ApiEpicProgress, "done" | "total">): string {
  return `${progress.done} of ${progress.total} done`;
}
