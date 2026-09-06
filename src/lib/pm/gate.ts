export interface PmGateFields {
  enabled?: boolean;
  lockedByInstance?: boolean;
}

export function isPmRunnable<T extends PmGateFields>(pm: T | undefined | null): pm is T {
  return !!pm?.enabled && !pm.lockedByInstance;
}

export const PM_RUNNABLE_QUERY = {
  "pm.enabled": true,
  "pm.lockedByInstance": { $ne: true },
};

export function pmDisabledReason(pm: PmGateFields | undefined | null): string {
  if (pm?.lockedByInstance) return "PM agent is disabled for this project by an instance admin";
  return "PM agent is not enabled for this project";
}

export function isPmLockedByInstance(pm: PmGateFields | undefined | null): boolean {
  return !!pm?.lockedByInstance;
}
