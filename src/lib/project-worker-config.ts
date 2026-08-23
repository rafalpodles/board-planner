import {
  PROJECT_POLICY_DEFAULTS,
  isGitRefName,
  isModelName,
  isProjectPolicyField,
} from "@/lib/worker-policy";

const BOOLEAN_FIELDS: ReadonlySet<string> = new Set<string>();

// Each string field with the shape its value has to have, because none of them stays data: they
// reach a worker in the assignment policy and are spent as arguments to git and to the CLI. A
// non-empty string was the only check, which let an option through — see worker-policy.ts.
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

// Builds a dotted $set rather than replacing `project.worker` wholesale: a partial patch that
// overwrote the object would silently reset every field the caller did not mention.
export function parseProjectWorkerConfig(
  input: unknown,
  existingOverrides: string[] = [],
  // The stored values this patch lands on. Needed because the one rule here is cross-field, and a
  // partial patch cannot be judged on its own: setting autoMerge alone is fine or fatal depending
  // on a reviewGate the request never mentions.
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

  // Un-pinning, the other half of policyOverrides. Without it a field touched once could never
  // follow the default again, and the UI would show "set" with no route back.
  const reset = body.reset;
  const cleared = new Set<string>();
  if (reset !== undefined) {
    if (!Array.isArray(reset)) return { ok: false, error: "worker.reset must be an array" };
    for (const field of reset) {
      if (typeof field !== "string" || !isProjectPolicyField(field)) {
        return { ok: false, error: `${String(field)} is not a worker policy field` };
      }
      // The stored copy goes back to the default too, so the document never holds a value that
      // nothing resolves against — a later reader would have no way to tell it was stale.
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

  // Recorded even when the value equals the default: pinning a field so a later change to the
  // default does not move it is exactly what an operator may be doing.
  if (touched.size > 0 || cleared.size > 0) {
    const next = new Set([...existingOverrides, ...touched]);
    for (const field of cleared) next.delete(field);
    update["worker.policyOverrides"] = [...next];
  }

  if (Object.keys(update).length === 0) {
    return { ok: false, error: "worker had nothing to update" };
  }

  // A cross-field rule used to live here, refusing autoMerge while the review gate was off. Both
  // fields are retired: an agent merges if its composition carries a Merge step, and whether the
  // change was reviewed is read off the same sequence by src/lib/agent-rules.ts.

  return { ok: true, update };
}
