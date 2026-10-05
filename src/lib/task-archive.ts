export const NOT_ARCHIVED = { archivedAt: null } as const;

export type ArchivedScope = "exclude" | "only" | "include";

const ARCHIVED_SCOPES: readonly string[] = ["exclude", "only", "include"];

export function archivedScopeOf(raw: string | null | undefined): ArchivedScope | null {
  if (raw === null || raw === undefined || raw === "") return "exclude";
  return ARCHIVED_SCOPES.includes(raw) ? (raw as ArchivedScope) : null;
}

export function archivedFilter(scope: ArchivedScope): Record<string, unknown> {
  if (scope === "only") return { archivedAt: { $ne: null } };
  if (scope === "include") return {};
  return NOT_ARCHIVED;
}
