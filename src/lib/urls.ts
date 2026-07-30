const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

export function isObjectIdSegment(segment: string): boolean {
  return OBJECT_ID_PATTERN.test(segment);
}

export function projectPath(projectRef: string): string {
  return `/projects/${projectRef}`;
}

export function taskPath(projectRef: string, taskRef: string | number): string {
  return `/projects/${projectRef}/tasks/${taskRef}`;
}
