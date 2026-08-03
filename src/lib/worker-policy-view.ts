import { ApiWorker } from "@/types";
import { POLICY_DEFAULTS, PolicyField } from "@/lib/worker-policy";

export interface PolicyRow {
  field: PolicyField;
  value: string;
  defaultValue: string;
  overridden: boolean;
}

const MILLISECOND_FIELDS: ReadonlySet<string> = new Set([
  "pollIntervalMs",
  "taskTimeoutMs",
]);

function format(field: PolicyField, value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (MILLISECOND_FIELDS.has(field)) return `${Math.round(Number(value) / 1000)}s`;
  return String(value);
}

// A field is overridden only if an operator set it. The stored value cannot say so on its own: the
// schema writes a default into every field at creation, so a stored 400 and a chosen 400 are the
// same bytes. `policyOverrides` is the only record of intent, which is why it is read here rather
// than comparing values.
export function policyRows(worker: Pick<ApiWorker, "policy" | "policyOverrides">): PolicyRow[] {
  const overrides = new Set(worker.policyOverrides ?? []);
  const stored = (worker.policy ?? {}) as unknown as Record<string, unknown>;

  return (Object.keys(POLICY_DEFAULTS) as PolicyField[]).map((field) => {
    const overridden = overrides.has(field);
    const fallback = POLICY_DEFAULTS[field];
    return {
      field,
      // An inherited field shows the default, not the stored copy of it — they can differ once a
      // default is changed, and the default is what the worker will actually run under.
      value: format(field, overridden ? stored[field] : fallback),
      defaultValue: format(field, fallback),
      overridden,
    };
  });
}
