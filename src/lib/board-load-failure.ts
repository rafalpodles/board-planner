/**
 * The refusal in words, from the status the API already reports. The server's own text is
 * deliberately unhelpful for two of these — `withProjectAccess` answers "Forbidden" or "Project
 * not found" and the split between them is a security decision, not a message (`middleware.ts`),
 * so the sentence a reader gets is made here rather than echoed.
 *
 * `retryable` is false for both: reading the same board again returns the same refusal, so a
 * Retry button beside it only teaches the reader that the page is broken.
 */
export function boardLoadFailure(
  reason: unknown,
  subject: string,
): { message: string; retryable: boolean } {
  const { status, message } = (reason ?? {}) as {
    status?: number;
    message?: string;
  };
  if (status === 403)
    return {
      message: "You do not have access to this board.",
      retryable: false,
    };
  if (status === 404) {
    return {
      message: "There is no board here — the link may be stale.",
      retryable: false,
    };
  }
  return {
    message: message
      ? `${subject} could not be loaded: ${message}`
      : `${subject} could not be loaded.`,
    retryable: true,
  };
}
