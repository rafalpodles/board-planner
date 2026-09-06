export function taskKeyOf(projectKey: string | null | undefined, taskNumber: number): string {
  return projectKey ? `${projectKey}-${taskNumber}` : `#${taskNumber}`;
}
