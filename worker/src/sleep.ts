// A pending setTimeout is a referenced handle, so a worker that merely stops *waiting* on its poll
// interval still holds the event loop open for the rest of it — long enough for launchd to give up
// and SIGKILL. The timer has to be cleared, not out-raced.
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };

    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
