import { PROJECT_POLICY_DEFAULTS, WORKER_POLICY_DEFAULTS } from "@/lib/worker-policy";

export interface PolicyRow {
  field: string;
  value: string;
  defaultValue: string;
  overridden: boolean;
}

export interface PolicyHolder {
  policy?: Record<string, unknown> | null;
  policyOverrides?: string[] | null;
}

const MILLISECOND_FIELDS: ReadonlySet<string> = new Set(["pollIntervalMs", "taskTimeoutMs"]);

function format(field: string, value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (value === undefined || value === null || value === "") return "—";
  if (MILLISECOND_FIELDS.has(field)) return `${Math.round(Number(value) / 1000)}s`;
  return String(value);
}

// A field is overridden only if an operator set it. The stored value cannot say so on its own: the
// schema writes a default into every field at creation, so a stored 400 and a chosen 400 are the
// same bytes. `policyOverrides` is the only record of intent, which is why it is read here rather
// than comparing values.
export function policyRows(
  holder: PolicyHolder,
  defaults: Record<string, unknown>
): PolicyRow[] {
  const overrides = new Set(holder.policyOverrides ?? []);
  const stored = (holder.policy ?? {}) as Record<string, unknown>;

  return Object.keys(defaults).map((field) => {
    const overridden = overrides.has(field);
    const fallback = defaults[field];
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

export const workerPolicyRows = (holder: PolicyHolder): PolicyRow[] =>
  policyRows(holder, WORKER_POLICY_DEFAULTS);

export const projectPolicyRows = (holder: PolicyHolder): PolicyRow[] =>
  policyRows(holder, PROJECT_POLICY_DEFAULTS);
