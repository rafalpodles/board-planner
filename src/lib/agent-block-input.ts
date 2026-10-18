import { gateKindByKey, GATE_KINDS, CAPABILITIES, DEFAULT_PROVIDER, isProvider, PROVIDER_IDS, ProviderId } from "./agent-kinds";
import { isModelName } from "./worker-policy";

export function gateKindRefusal(value: unknown): string | null {
  if (typeof value === "string" && gateKindByKey(value)) return null;
  return `gateKind must be one of ${GATE_KINDS.map((k) => k.key).join(", ")}`;
}

// Absent and empty both mean "not set": the worker then runs the model it is configured with.
export function modelRefusal(value: unknown, field: string): string | null {
  if (value === undefined || value === "") return null;
  if (typeof value === "string" && isModelName(value)) return null;
  return `${field} must be a model name such as opus or sonnet`;
}

// A pair that cannot exist is refused where it can be seen. A Claude model id is any name, so the
// refusal goes by what each vendor's names look like rather than by a list that would be wrong the
// month a model ships.
const OPENAI_MODEL = /^(gpt|o\d|codex|chatgpt)/i;
const CLAUDE_MODEL = /^(opus|sonnet|haiku|claude)/i;

export function providerRefusal(value: unknown): string | null {
  if (value === undefined || isProvider(value)) return null;
  return `provider must be one of ${PROVIDER_IDS.join(", ")}`;
}

/**
 * A model that belongs to its provider. Claude's may be left empty (the worker then runs the one it
 * is configured with); Codex's may not, because the model a Codex account offers is the account's own
 * and there is no default to fall back to that is true for everybody.
 */
export function modelForProviderRefusal(provider: ProviderId, value: unknown, field: string): string | null {
  const named = modelRefusal(value, field);
  if (named) return named;
  const model = typeof value === "string" ? value : "";
  if (provider === "codex") {
    if (!model) return `${field} is required for Codex: name a model the machine's Codex account offers`;
    if (CLAUDE_MODEL.test(model)) return `${field} "${model}" is a Claude model, not a Codex one`;
    return null;
  }
  return OPENAI_MODEL.test(model) ? `${field} "${model}" is not a Claude model: choose Codex as the provider` : null;
}

/** Codex has no fallback model, so a step on it names none */
export function fallbackForProviderRefusal(provider: ProviderId, value: unknown): string | null {
  const named = modelRefusal(value, "fallbackModel");
  if (named) return named;
  const model = typeof value === "string" ? value : "";
  if (provider === "codex") return model ? "fallbackModel is not used by Codex" : null;
  return OPENAI_MODEL.test(model) ? `fallbackModel "${model}" is not a Claude model` : null;
}

export function capabilityRefusal(value: unknown): string | null {
  if (value === undefined) return null;
  if (CAPABILITIES.some((c) => c.value === value)) return null;
  return `capability must be one of ${CAPABILITIES.map((c) => c.value).join(", ")}`;
}

/** Only the parameters the gate's kind declares, as strings; anything else is dropped. */
export function gateParams(
  gateKind: unknown,
  value: unknown
): { params: Record<string, string>; refusal: string | null } {
  const kind = typeof gateKind === "string" ? gateKindByKey(gateKind) : undefined;
  const declared = new Set(kind?.params.map((p) => p.key) ?? []);
  const params: Record<string, string> = {};
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (declared.has(k) && (typeof v === "string" || typeof v === "number")) params[k] = String(v);
    }
  }
  // The gate that names a provider names a model for it; one that names neither keeps the old rule
  const provider = isProvider(params.provider) ? params.provider : DEFAULT_PROVIDER;
  const refusal =
    ("provider" in params ? providerRefusal(params.provider) : null) ??
    ("model" in params || provider === "codex"
      ? modelForProviderRefusal(provider, params.model ?? "", "params.model")
      : null);
  return { params, refusal };
}
