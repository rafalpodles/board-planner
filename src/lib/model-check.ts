import type { ScopedDb } from "@/lib/db-scope";
import { can } from "@/lib/entitlements";
import { isManagedModel, openrouterModel, unmanagedModelError } from "@/lib/managed-models";
import { modelsRestricted } from "@/lib/model-keys";
import { getOrganisation } from "@/lib/organisation";
import { organisationDomain } from "@/lib/organisation-host";
import { isListed, listCatalogue } from "@/lib/openrouter-catalogue";
import { DEFAULT_AI_MODEL } from "@/lib/ai-model";

/** The model the PM agent and AI Assist run on where a project names none */
export async function savedAiModel(db: ScopedDb): Promise<string> {
  return (await db.Settings.findOne({}, "aiModel").lean())?.aiModel || DEFAULT_AI_MODEL;
}

/** Why a model cannot be saved, or null. An empty name is no choice at all: a project that names none follows the default */
export async function refuseModel(db: ScopedDb, model: string): Promise<string | null> {
  const name = openrouterModel(model.trim());
  if (!model.trim()) return null;
  if (isManagedModel(name) === false && (await modelsRestricted(db))) return unmanagedModelError(name);
  const catalogue = await listCatalogue();
  if (catalogue && !isListed(catalogue, name)) return `OpenRouter has no model ${name}. Check the name against openrouter.ai/models.`;
  return null;
}

async function platformKeyWouldRun(db: ScopedDb): Promise<boolean> {
  if (organisationDomain() === null || !process.env.OPENROUTER_API_KEY) return false;
  return can(await getOrganisation(db.organisation), "ai.managed");
}

/** The models in use that only the organisation's own key runs, when removing that key would hand the calls to ours */
export async function modelsLostWithOwnKey(db: ScopedDb): Promise<string[]> {
  if (!(await platformKeyWouldRun(db))) return [];
  const [saved, projects] = await Promise.all([
    savedAiModel(db),
    db.Project.find({ "pm.model": { $nin: [null, ""] } }, "pm.model").lean(),
  ]);
  const used = new Set([saved, ...projects.map((p) => p.pm?.model)].filter((m): m is string => !!m?.trim()));
  return [...used].map(openrouterModel).filter((m) => !isManagedModel(m));
}
