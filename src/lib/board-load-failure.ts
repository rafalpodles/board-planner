// The API's own text is deliberately vague (see `withProjectAccess`), so the reader's is made here
export function boardRefusal(reason: unknown): string | null {
  const status = (reason as { status?: number } | null)?.status;
  if (status === 403) return "You do not have access to this board.";
  if (status === 404) return "There is no board here — the link may be stale.";
  return null;
}
