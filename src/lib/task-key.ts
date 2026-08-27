/**
 * `BP-42`, or `#42` when the project cannot be resolved — a task deleted with its board, or a
 * payload assembled before the project was read. Both spellings were already open-coded in five
 * places; this is the one that decides which.
 */
export function taskKeyOf(projectKey: string | null | undefined, taskNumber: number): string {
  return projectKey ? `${projectKey}-${taskNumber}` : `#${taskNumber}`;
}
