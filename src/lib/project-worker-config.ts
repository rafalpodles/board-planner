import { isProjectPolicyField } from "@/lib/worker-policy";

const BOOLEAN_FIELDS: ReadonlySet<string> = new Set(["autoMerge"]);
const STRING_FIELDS: ReadonlySet<string> = new Set([
  "baseBranch",
  "model",
  "fallbackModel",
  "reviewModel",
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
  existingOverrides: string[] = []
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
        if (typeof value !== "string" || !value.trim()) {
          return { ok: false, error: `${field} must be a non-empty string` };
        }
      } else if (!isPositiveInt(value)) {
        return { ok: false, error: `${field} must be a positive integer` };
      }
      update[`worker.policy.${field}`] =
        typeof value === "string" ? value.trim() : value;
      touched.add(field);
    }
  }

  // Recorded even when the value equals the default: pinning a field so a later change to the
  // default does not move it is exactly what an operator may be doing.
  if (touched.size > 0) {
    update["worker.policyOverrides"] = [...new Set([...existingOverrides, ...touched])];
  }

  if (Object.keys(update).length === 0) {
    return { ok: false, error: "worker had nothing to update" };
  }
  return { ok: true, update };
}
