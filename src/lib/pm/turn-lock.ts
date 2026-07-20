// In-memory per-project turn lock. Single-instance deployment (Railway), same
// trade-off as src/lib/rate-limit.ts.
const inFlight = new Set<string>();

export function acquireTurnLock(projectId: string): boolean {
  if (inFlight.has(projectId)) return false;
  inFlight.add(projectId);
  return true;
}

export function releaseTurnLock(projectId: string): void {
  inFlight.delete(projectId);
}
