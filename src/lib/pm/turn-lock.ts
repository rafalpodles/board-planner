// In-memory per-project turn lock. Single-instance deployment (Railway), same
// trade-off as src/lib/rate-limit.ts. The controller doubles as the interrupt
// channel: whoever holds the lock passes its signal into the turn.
//
// The lock stays per PROJECT even though conversations are per user: the agent
// mutates one shared board, and two turns at once can duplicate tasks or fight
// over the same status. The owner is recorded so an interrupt can tell "stop my
// turn" from "stop someone else's".
interface TurnLock {
  controller: AbortController;
  userId: string;
}

const inFlight = new Map<string, TurnLock>();

export function acquireTurnLock(projectId: string, userId: string): AbortController | null {
  if (inFlight.has(projectId)) return null;
  const controller = new AbortController();
  inFlight.set(projectId, { controller, userId });
  return controller;
}

export function releaseTurnLock(projectId: string): void {
  inFlight.delete(projectId);
}

export function isTurnRunning(projectId: string): boolean {
  return inFlight.has(projectId);
}

export type InterruptOutcome = "interrupted" | "not-running" | "forbidden";

export function interruptTurn(
  projectId: string,
  requesterId: string,
  canOverride = false
): InterruptOutcome {
  const lock = inFlight.get(projectId);
  if (!lock) return "not-running";
  if (lock.userId !== requesterId && !canOverride) return "forbidden";
  lock.controller.abort();
  return "interrupted";
}
