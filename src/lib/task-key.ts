/**
 * `BP-42`, or `#42` when the project cannot be resolved — a task deleted with its board, or a
 * payload assembled before the project was read.
 *
 * `task-service.ts` open-coded both spellings nine times, in three variants that disagreed about
 * the missing-project case; it now asks here. About a dozen sites elsewhere still spell it out —
 * a sweep worth its own change, not this one.
 */
export function taskKeyOf(projectKey: string | null | undefined, taskNumber: number): string {
  return projectKey ? `${projectKey}-${taskNumber}` : `#${taskNumber}`;
}
