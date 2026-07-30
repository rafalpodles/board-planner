// In-memory per-project turn lock. Single-instance deployment (Railway), same
// trade-off as src/lib/rate-limit.ts. The controller doubles as the interrupt
// channel: whoever holds the lock passes its signal into the turn.
const inFlight = new Map<string, AbortController>();

export function acquireTurnLock(projectId: string): AbortController | null {
  if (inFlight.has(projectId)) return null;
  const controller = new AbortController();
  inFlight.set(projectId, controller);
  return controller;
}

export function releaseTurnLock(projectId: string): void {
  inFlight.delete(projectId);
}

export function interruptTurn(projectId: string): boolean {
  const controller = inFlight.get(projectId);
  if (!controller) return false;
  controller.abort();
  return true;
}
