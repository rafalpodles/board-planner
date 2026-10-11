import { APP_NAME } from "./brand";

export interface ManagedProvider {
  /** The model id's prefix on OpenRouter: `openai` in `openai/gpt-4o` */
  id: string;
  label: string;
  /** Model names, after the prefix, that the provider does not serve itself */
  excluded?: RegExp;
  /** OpenRouter's provider slugs a request is pinned to, so that it cannot fall back to another host */
  servedBy: string[];
  description: string;
}

// Adding a provider here is a change of sub-processor: the DPA's Annex 3 and the transfer assessment come first
// The open-weight models (gpt-oss, gemma) are hosted by others on OpenRouter, so they are not the provider's to serve
export const MANAGED_MODEL_PROVIDERS: readonly ManagedProvider[] = [
  { id: "openai", label: "OpenAI", excluded: /^gpt-oss/, servedBy: ["openai"], description: "OpenAI's own models (openai/…, not gpt-oss)" },
  { id: "anthropic", label: "Anthropic", servedBy: ["anthropic"], description: "Anthropic's own models (anthropic/…)" },
  { id: "google", label: "Google", excluded: /^gemma/, servedBy: ["google-vertex"], description: "Google's models on Vertex AI (google/…, not gemma)" },
  { id: "mistralai", label: "Mistral", servedBy: ["mistral"], description: "Mistral's own models (mistralai/…)" },
];

/** The AI Assist model setting predates OpenRouter and holds a bare OpenAI name such as `gpt-4o-mini` */
export const openrouterModel = (model: string): string => (model.includes("/") ? model : `openai/${model}`);

// No ":" anywhere: OpenRouter's variant suffixes switch on more than a model, :online a web search by a third party
export function managedProviderOf(model: string): ManagedProvider | null {
  if (model.includes(":")) return null;
  const slash = model.indexOf("/");
  if (slash < 1) return null;
  const name = model.slice(slash + 1);
  const provider = MANAGED_MODEL_PROVIDERS.find((p) => p.id === model.slice(0, slash));
  return provider && name && !provider.excluded?.test(name) ? provider : null;
}

export const isManagedModel = (model: string): boolean => managedProviderOf(model) !== null;

export function unmanagedModelError(model: string): string {
  const allowed = MANAGED_MODEL_PROVIDERS.map((p) => p.description).join(", ");
  return `The model ${model} is not available on ${APP_NAME}'s AI key. Choose one of: ${allowed}, or add your organisation's own OpenRouter key in Settings → AI key.`;
}
