// Deliberately free of imports: both consoles render these in the browser, and reaching them
// through worker-service would drag mongoose into the client bundle.
//
// Mirrors the worker's own defaults (worker/src/config.ts). A field nobody overrode resolves
// against these on the worker, which is what lets a changed default reach every machine.

// Facts about a laptop, not about the work. Everything else describes a repository and moved to the
// project, where an operator can set it once instead of once per machine.
export const WORKER_POLICY_DEFAULTS = {
  pollIntervalMs: 30_000,
} as const;

// Facts about a repository and the work done in it. Set per project; every worker serving that
// project resolves against the same values.
export const PROJECT_POLICY_DEFAULTS = {
  // Off by default: merging to a base branch is a thing an operator turns on, not a thing a
  // freshly enabled project starts doing
  autoMerge: false,
  // The second model that reads the diff with no memory of writing it. On by default because
  // "nothing merges unreviewed" is the safety property the worker asserts outright, and turning
  // this off is the one thing that could quietly undo it.
  reviewGate: true,
  baseBranch: "main",
  taskTimeoutMs: 1_800_000,
  maxDiffLines: 400,
  maxDiffFiles: 10,
  model: "opus",
  fallbackModel: "sonnet",
  reviewModel: "opus",
} as const;

export type WorkerPolicyField = keyof typeof WORKER_POLICY_DEFAULTS;
export type ProjectPolicyField = keyof typeof PROJECT_POLICY_DEFAULTS;

const WORKER_FIELD_NAMES = new Set<string>(Object.keys(WORKER_POLICY_DEFAULTS));
const PROJECT_FIELD_NAMES = new Set<string>(Object.keys(PROJECT_POLICY_DEFAULTS));

export function isWorkerPolicyField(name: string): name is WorkerPolicyField {
  return WORKER_FIELD_NAMES.has(name);
}

export function isProjectPolicyField(name: string): name is ProjectPolicyField {
  return PROJECT_FIELD_NAMES.has(name);
}
