import { getSettings } from "@/models/settings";
import { DEFAULT_PM_MODEL } from "./openrouter";

const FALLBACK_DAILY_TURN_CAP = 100;

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

// project value → instance setting → env var → hard fallback
export async function resolvePmModel(projectModel?: string): Promise<string> {
  if (projectModel) return projectModel;
  const settings = await getSettings();
  return settings.pmDefaultModel || DEFAULT_PM_MODEL();
}

export async function resolveDailyTurnCap(projectCap?: number): Promise<number> {
  if (projectCap) return projectCap;
  const settings = await getSettings();
  return (
    settings.pmDefaultDailyTurnCap ||
    Number(process.env.PM_DAILY_TURN_CAP) ||
    FALLBACK_DAILY_TURN_CAP
  );
}
