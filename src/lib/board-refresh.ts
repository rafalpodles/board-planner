const EVENT = "boardplanner:board-refresh";
const CHANNEL = "boardplanner:board";

// A window CustomEvent only reaches listeners in the tab that dispatched it, so a board
// sitting beside the PM page in another tab would still wait for the 10s poll.
// BroadcastChannel carries the same signal across tabs; it never echoes to the sender,
// so the two paths cannot double-fire.
let sharedChannel: BroadcastChannel | null | undefined;

function getChannel(): BroadcastChannel | null {
  if (sharedChannel === undefined) {
    sharedChannel =
      typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel(CHANNEL)
        : null;
  }
  return sharedChannel;
}

// Lets the PM chat tell any mounted board/list view to reload
// immediately after a write action, instead of waiting for the 10s poll
export function emitBoardRefresh(projectId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { projectId } }));
  getChannel()?.postMessage({ projectId });
}

// A PM turn emits once per write action, seconds apart, and each reload refetches the whole
// board (~210 KB on a 140-task project). Coalescing here rather than in each subscriber:
// the first event still reloads at once, the rest of the burst collapses into one trailing run.
const MIN_RELOAD_INTERVAL_MS = 1200;

export function subscribeBoardRefresh(projectId: string, callback: () => void): () => void {
  const matches = (id?: string) => !id || id === projectId;

  let lastRun = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;

  const run = () => {
    lastRun = Date.now();
    callback();
  };

  const schedule = () => {
    const sinceLast = Date.now() - lastRun;
    if (sinceLast >= MIN_RELOAD_INTERVAL_MS) {
      run();
      return;
    }
    if (trailing) return;
    trailing = setTimeout(() => {
      trailing = null;
      run();
    }, MIN_RELOAD_INTERVAL_MS - sinceLast);
  };

  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ projectId?: string }>).detail;
    if (matches(detail?.projectId)) schedule();
  };
  window.addEventListener(EVENT, handler);

  const channel = getChannel();
  const onMessage = (e: MessageEvent<{ projectId?: string }>) => {
    if (matches(e.data?.projectId)) schedule();
  };
  channel?.addEventListener("message", onMessage);

  return () => {
    if (trailing) clearTimeout(trailing);
    window.removeEventListener(EVENT, handler);
    channel?.removeEventListener("message", onMessage);
  };
}
