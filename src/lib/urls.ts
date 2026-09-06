const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

// The single source for the key's length cap — a UI field's own maxLength and the rule text
// shown for a rejected key both import this rather than restating "20" (BP-535).
export const PROJECT_KEY_MAX_LENGTH = 20;
export const PROJECT_KEY_PATTERN = new RegExp(
  `^[A-Za-z][A-Za-z0-9_-]{0,${PROJECT_KEY_MAX_LENGTH - 1}}$`
);

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

export function isTaskPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const [, base, ref, tasks, taskRef] = pathname.split("/");
  return base === "projects" && !!projectRefFromPathname(`/${base}/${ref}`) && tasks === "tasks" && !!taskRef;
}

/** The task a task URL names, or undefined if it names none. */
export function taskRefFromPathname(pathname: string | null | undefined): string | undefined {
  if (!isTaskPath(pathname)) return undefined;
  return pathname!.split("/")[4];
}
