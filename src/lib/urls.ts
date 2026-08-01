const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

export const PROJECT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/;

// Routes under /projects that are pages in their own right, not a project ref
const RESERVED_PROJECT_SEGMENTS = new Set(["new"]);

export function isObjectIdSegment(segment: string): boolean {
  return OBJECT_ID_PATTERN.test(segment);
}

export function projectRefFromPathname(
  pathname: string | null | undefined
): string | undefined {
  if (!pathname) return undefined;
  const [, base, ref] = pathname.split("/");
  if (base !== "projects" || !ref || RESERVED_PROJECT_SEGMENTS.has(ref)) {
    return undefined;
  }
  return isObjectIdSegment(ref) || PROJECT_KEY_PATTERN.test(ref) ? ref : undefined;
}

export function projectPath(projectRef: string): string {
  return `/projects/${projectRef}`;
}

export function taskPath(projectRef: string, taskRef: string | number): string {
  return `/projects/${projectRef}/tasks/${taskRef}`;
}
