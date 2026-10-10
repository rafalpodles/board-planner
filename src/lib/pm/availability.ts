import type { ScopedDb } from "@/lib/db-scope";
import { getSettings } from "@/models/settings";
import { openrouterModel } from "@/lib/managed-models";

// Server-side callers keep importing the gate from here; the definitions live in
// ./gate so client components can share them without pulling mongoose into the bundle
export {
  isPmRunnable,
  isPmLockedByInstance,
  pmDisabledReason,
  PM_RUNNABLE_QUERY,
} from "./gate";
export type { PmGateFields } from "./gate";

// project value → the instance's one AI model, which AI Assist uses too
export async function resolvePmModel(db: ScopedDb, projectModel?: string): Promise<string> {
  if (projectModel) return projectModel;
  return openrouterModel((await getSettings(db)).aiModel);
}
