const EVENT = "claudeplanner:board-refresh";

// Lets the PM chat tell any mounted board/list/timeline view to reload
// immediately after a write action, instead of waiting for the 10s poll
export function emitBoardRefresh(projectId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { projectId } }));
}

export function subscribeBoardRefresh(projectId: string, callback: () => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ projectId?: string }>).detail;
    if (!detail?.projectId || detail.projectId === projectId) callback();
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
