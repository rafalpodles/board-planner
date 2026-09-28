import { gateKindByKey, GATE_KINDS, CAPABILITIES } from "./agent-kinds";
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
  const refusal = "model" in params ? modelRefusal(params.model, "params.model") : null;
  return { params, refusal };
}
