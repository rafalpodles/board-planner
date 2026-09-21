// The API's own words are "Forbidden" and "Project not found", deliberately; the split between
// them is a security decision in `middleware.ts`, so the sentence a reader gets is made here
export function boardRefusal(reason: unknown): string | null {
  const status = (reason as { status?: number } | null)?.status;
  if (status === 403) return "You do not have access to this board.";
  if (status === 404) return "There is no board here — the link may be stale.";
  return null;
}
