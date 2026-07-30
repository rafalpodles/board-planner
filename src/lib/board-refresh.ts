const EVENT = "claudeplanner:board-refresh";
const CHANNEL = "claudeplanner:board";

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

// Lets the PM chat tell any mounted board/list/timeline view to reload
// immediately after a write action, instead of waiting for the 10s poll
export function emitBoardRefresh(projectId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { projectId } }));
  getChannel()?.postMessage({ projectId });
}

export function subscribeBoardRefresh(projectId: string, callback: () => void): () => void {
  const matches = (id?: string) => !id || id === projectId;

  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ projectId?: string }>).detail;
    if (matches(detail?.projectId)) callback();
  };
  window.addEventListener(EVENT, handler);

  const channel = getChannel();
  const onMessage = (e: MessageEvent<{ projectId?: string }>) => {
    if (matches(e.data?.projectId)) callback();
  };
  channel?.addEventListener("message", onMessage);

  return () => {
    window.removeEventListener(EVENT, handler);
    channel?.removeEventListener("message", onMessage);
  };
}
