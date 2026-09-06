export const LEASE_MS = 2 * 60 * 60_000;

export const DEFAULT_RUN_CEILING_MS = 90 * 60_000;

const MARGIN_MS = 15 * 60_000;

export function clampCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_RUN_CEILING_MS;
  return Math.min(value, LEASE_MS - MARGIN_MS);
}

export function createBudget(ceilingMs: number, now: () => number = Date.now) {
  const deadline = now() + ceilingMs;
  return {
    remaining: () => deadline - now(),
    forEntry: (capMs: number) => Math.max(0, Math.min(capMs, deadline - now())),
    exhausted: () => now() >= deadline,
  };
}
