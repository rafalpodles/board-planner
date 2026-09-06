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
