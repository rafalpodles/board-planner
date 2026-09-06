import { getSettings } from "@/models/settings";
import { DEFAULT_PM_MODEL } from "./openrouter";

const FALLBACK_DAILY_TURN_CAP = 100;

export {
  isPmRunnable,
  isPmLockedByInstance,
  pmDisabledReason,
  PM_RUNNABLE_QUERY,
} from "./gate";
export type { PmGateFields } from "./gate";

export async function resolvePmModel(projectModel?: string): Promise<string> {
  if (projectModel) return projectModel;
  const settings = await getSettings();
  return settings.pmDefaultModel || DEFAULT_PM_MODEL();
}

export async function resolveDailyTokenCap(projectCap?: number): Promise<number> {
  if (projectCap) return projectCap;
  const fromEnv = Number(process.env.PM_DAILY_TOKEN_CAP);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 0;
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
