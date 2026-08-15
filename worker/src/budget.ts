/** Mirrors EXECUTION_LEASE_MS in src/lib/task-service.ts. */
export const LEASE_MS = 2 * 60 * 60_000;

export const DEFAULT_RUN_CEILING_MS = 90 * 60_000;

// A quarter hour under the lease: the server's clock starts at the claim and the worker's at the
// run, and between them sit the claim round trip and creating the worktree.
const MARGIN_MS = 15 * 60_000;

/**
 * Clamped locally rather than obeyed, for the reason applyPolicy recomputes the rest of the policy:
 * a server saying four hours would outlive the lease, the task would be reclaimed under a running
 * worker, and the abort would read as the machine dying.
 */
export function clampCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_RUN_CEILING_MS;
  return Math.min(value, LEASE_MS - MARGIN_MS);
}

export function createBudget(ceilingMs: number, now: () => number = Date.now) {
  const deadline = now() + ceilingMs;
  return {
    remaining: () => deadline - now(),
    // The cap is the caller's, because a model step and a gate are bounded by different settings.
    // Whichever is smaller wins: the ceiling is what the whole run may take.
    forEntry: (capMs: number) => Math.max(0, Math.min(capMs, deadline - now())),
    exhausted: () => now() >= deadline,
  };
}
