import type { ScopedDb } from "@/lib/db-scope";
import { getSettings } from "@/models/settings";
import { DEFAULT_PM_MODEL } from "./openrouter";

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
export async function resolvePmModel(db: ScopedDb, projectModel?: string): Promise<string> {
  if (projectModel) return projectModel;
  const settings = await getSettings(db);
  return settings.pmDefaultModel || DEFAULT_PM_MODEL();
}
