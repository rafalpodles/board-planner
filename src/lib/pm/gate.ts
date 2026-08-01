// Kept free of imports so client components can ask the same question the server does.
// The async resolvers that need Mongo live in ./availability, which re-exports this.

export interface PmGateFields {
  enabled?: boolean;
  lockedByInstance?: boolean;
}

// Every runtime path asks this rather than reading pm.enabled directly, so an
// instance lock cannot be honoured in one entry point and missed in another
// Type guard, so callers keep the narrowing the old `pm?.enabled` check gave them
export function isPmRunnable<T extends PmGateFields>(pm: T | undefined | null): pm is T {
  return !!pm?.enabled && !pm.lockedByInstance;
}

// Mongo equivalent of isPmRunnable, for queries that select projects in bulk
export const PM_RUNNABLE_QUERY = {
  "pm.enabled": true,
  "pm.lockedByInstance": { $ne: true },
};

export function pmDisabledReason(pm: PmGateFields | undefined | null): string {
  if (pm?.lockedByInstance) return "PM agent is disabled for this project by an instance admin";
  return "PM agent is not enabled for this project";
}

// A project admin can flip pm.enabled; only an instance admin can clear the lock
export function isPmLockedByInstance(pm: PmGateFields | undefined | null): boolean {
  return !!pm?.lockedByInstance;
}
