// Deliberately free of imports: the fleet console renders these in the browser, and reaching them
// through worker-service would drag mongoose into the client bundle.
//
// Mirrors the worker's own DEFAULT_POLICY (worker/src/config.ts). A field absent from a worker's
// overrides resolves against this on the worker, which is what lets a changed default reach every
// machine that never pinned it.
export const POLICY_DEFAULTS = {
  // Off by default: merging to a base branch is a thing an operator turns on, not a thing a
  // freshly registered worker starts doing
  autoMerge: false,
  baseBranch: "main",
  pollIntervalMs: 30_000,
  taskTimeoutMs: 1_800_000,
  maxDiffLines: 400,
  maxDiffFiles: 10,
  model: "opus",
  fallbackModel: "sonnet",
  reviewModel: "opus",
} as const;

export type PolicyField = keyof typeof POLICY_DEFAULTS;

const POLICY_FIELD_NAMES = new Set<string>(Object.keys(POLICY_DEFAULTS));

export function isPolicyField(name: string): name is PolicyField {
  return POLICY_FIELD_NAMES.has(name);
}
