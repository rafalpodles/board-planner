// Missing and inaccessible resources must not reveal whether a project exists.
export const MISSING_PAGE_MESSAGE = "We couldn’t find this page. The link may have changed, or this page may not be available to you.";

export function boardRefusal(reason: unknown): string | null {
  const status = (reason as { status?: number } | null)?.status;
  if (status === 403 || status === 404) return MISSING_PAGE_MESSAGE;
  return null;
}
