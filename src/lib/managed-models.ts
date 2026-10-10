import { APP_NAME } from "./brand";

const OPENAI_SERVED_BY_OPENAI = /^openai\/(?!gpt-oss)/;
// No ":" anywhere: OpenRouter's variant suffixes switch on more than a model, :online a web search by a third party
const ENTRY = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9._/-]*\*?$/;
const DEFAULT_DESCRIPTION = "OpenAI's own models (openai/…, not gpt-oss)";

/** The AI Assist model setting predates OpenRouter and holds a bare OpenAI name such as `gpt-4o-mini` */
export const openrouterModel = (model: string): string => (model.includes("/") ? model : `openai/${model}`);

export type ManagedModels = { kind: "default" } | { kind: "list"; exact: string[]; prefixes: string[]; entries: string[] };

export function managedModelsFromEnv(raw = process.env.MANAGED_AI_MODELS): ManagedModels {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return { kind: "default" };
  const malformed = entries.filter((entry) => !ENTRY.test(entry) || entry.endsWith("/"));
  if (malformed.length) {
    throw new Error(
      `MANAGED_AI_MODELS must be comma-separated OpenRouter model ids such as openai/gpt-4o-mini, or prefixes ending in * such as openai/gpt-4o*, with no :variant; got ${malformed.map((entry) => JSON.stringify(entry)).join(", ")}`
    );
  }
  return {
    kind: "list",
    entries,
    exact: entries.filter((entry) => !entry.endsWith("*")),
    prefixes: entries.filter((entry) => entry.endsWith("*")).map((entry) => entry.slice(0, -1)),
  };
}

export function assertManagedModelsConfig(hosted: boolean): void {
  if (hosted) managedModelsFromEnv();
}

export function isManagedModel(model: string, allowed = managedModelsFromEnv()): boolean {
  if (model.includes(":")) return false;
  if (allowed.kind === "default") return OPENAI_SERVED_BY_OPENAI.test(model);
  return allowed.exact.includes(model) || allowed.prefixes.some((prefix) => model.startsWith(prefix));
}

export function describeManagedModels(allowed = managedModelsFromEnv()): string {
  return allowed.kind === "default" ? DEFAULT_DESCRIPTION : allowed.entries.join(", ");
}

export function unmanagedModelError(model: string, allowed = managedModelsFromEnv()): string {
  return `The model ${model} is not available on ${APP_NAME}'s AI key. Choose one of: ${describeManagedModels(allowed)}, or add your organisation's own OpenRouter key in Settings → AI key.`;
}

function onlyOpenAiServedByOpenAi(entry: string): boolean {
  if (!entry.endsWith("*")) return OPENAI_SERVED_BY_OPENAI.test(entry);
  const prefix = entry.slice(0, -1);
  if (!prefix.startsWith("openai/")) return false;
  const rest = prefix.slice("openai/".length);
  return !"gpt-oss".startsWith(rest) && !rest.startsWith("gpt-oss");
}

export function managedModelWarnings(hosted: boolean, defaultPmModel: string): string[] {
  if (!hosted) {
    return process.env.MANAGED_AI_MODELS?.trim() ? ["WARNING: MANAGED_AI_MODELS is ignored without ORGANISATION_DOMAIN: a self-hosted instance's own key runs any model"] : [];
  }
  const warnings: string[] = [];
  const allowed = managedModelsFromEnv();
  const beyond = allowed.kind === "list" ? allowed.entries.filter((entry) => !onlyOpenAiServedByOpenAi(entry)) : [];
  if (beyond.length) {
    warnings.push(
      `WARNING: MANAGED_AI_MODELS allows ${beyond.join(", ")}, beyond OpenAI's own models served by OpenAI. The DPA's sub-processor list (OpenRouter and OpenAI) no longer matches where the platform's key sends prompts: update it before these models are used`
    );
  }
  if (!isManagedModel(defaultPmModel, allowed)) {
    warnings.push(
      `WARNING: the default PM model ${defaultPmModel} is not allowed on the platform's AI key (MANAGED_AI_MODELS), so a project that names no model of its own is refused there`
    );
  }
  return warnings;
}
