import { getSettings } from "@/models/settings";
import { DEFAULT_PM_MODEL } from "./openrouter";

const FALLBACK_DAILY_TURN_CAP = 100;

// Server-side callers keep importing the gate from here; the definitions live in
// ./gate so client components can share them without pulling mongoose into the bundle
export {
  isPmRunnable,
  isPmLockedByInstance,
  pmDisabledReason,
  PM_RUNNABLE_QUERY,
} from "./gate";
export type { PmGateFields } from "./gate";

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
