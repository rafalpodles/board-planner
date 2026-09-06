import {
  PROJECT_POLICY_DEFAULTS,
  isGitRefName,
  isModelName,
  isProjectPolicyField,
} from "@/lib/worker-policy";

const BOOLEAN_FIELDS: ReadonlySet<string> = new Set<string>();

const STRING_FIELDS: ReadonlyMap<string, { valid: (value: string) => boolean; expected: string }> =
  new Map([
    ["baseBranch", { valid: isGitRefName, expected: "a git branch name" }],
    ["model", { valid: isModelName, expected: "a model name" }],
    ["fallbackModel", { valid: isModelName, expected: "a model name" }],
    ["reviewModel", { valid: isModelName, expected: "a model name" }],
  ]);

export type WorkerConfigPatch =
  | { ok: true; update: Record<string, unknown> }
  | { ok: false; error: string };

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function parseProjectWorkerConfig(
  input: unknown,
  existingOverrides: string[] = [],
  existingPolicy: Record<string, unknown> = {}
): WorkerConfigPatch {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "worker must be an object" };
  }
  const body = input as Record<string, unknown>;
  const update: Record<string, unknown> = {};
  const touched = new Set<string>();

  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") {
      return { ok: false, error: "worker.enabled must be a boolean" };
    }
    update["worker.enabled"] = body.enabled;
  }

  const reset = body.reset;
  const cleared = new Set<string>();
  if (reset !== undefined) {
    if (!Array.isArray(reset)) return { ok: false, error: "worker.reset must be an array" };
    for (const field of reset) {
      if (typeof field !== "string" || !isProjectPolicyField(field)) {
        return { ok: false, error: `${String(field)} is not a worker policy field` };
      }
      update[`worker.policy.${field}`] = PROJECT_POLICY_DEFAULTS[field];
      cleared.add(field);
    }
  }

  const policy = body.policy;
  if (policy !== undefined) {
    if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
      return { ok: false, error: "worker.policy must be an object" };
    }
    for (const [field, value] of Object.entries(policy as Record<string, unknown>)) {
      if (!isProjectPolicyField(field)) {
        return { ok: false, error: `${field} is not a worker policy field` };
      }
      if (BOOLEAN_FIELDS.has(field)) {
        if (typeof value !== "boolean") {
          return { ok: false, error: `${field} must be a boolean` };
        }
      } else if (STRING_FIELDS.has(field)) {
        const shape = STRING_FIELDS.get(field)!;
        if (typeof value !== "string" || !value.trim()) {
          return { ok: false, error: `${field} must be a non-empty string` };
        }
        if (!shape.valid(value.trim())) {
          return { ok: false, error: `${field} must be ${shape.expected}` };
        }
      } else if (!isPositiveInt(value)) {
        return { ok: false, error: `${field} must be a positive integer` };
      }
      if (cleared.has(field)) {
        return { ok: false, error: `${field} cannot be set and reset in the same request` };
      }
      update[`worker.policy.${field}`] =
        typeof value === "string" ? value.trim() : value;
      touched.add(field);
    }
  }

  if (touched.size > 0 || cleared.size > 0) {
    const next = new Set([...existingOverrides, ...touched]);
    for (const field of cleared) next.delete(field);
    update["worker.policyOverrides"] = [...next];
  }

  if (Object.keys(update).length === 0) {
    return { ok: false, error: "worker had nothing to update" };
  }

  return { ok: true, update };
}
