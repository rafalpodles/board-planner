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

/**
 * The day's token ceiling, or 0 for none (BP-284).
 *
 * **Defaults to off, deliberately.** A turn is up to MAX_STEPS round-trips, so no number derived
 * from the existing turn cap describes what any particular deployment actually spends — and a
 * default that guessed low would stop the PM working, which is worse than a cap that bounds
 * nothing. What ships instead is the measurement: real per-day totals, on the screen, in the
 * operator's own units. Choosing the number is theirs to do from that data.
 */
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
