export const WORKER_POLICY_DEFAULTS = {
  pollIntervalMs: 30_000,
} as const;

export const PROJECT_POLICY_DEFAULTS = {
  baseBranch: "main",
  taskTimeoutMs: 1_800_000,
  runCeilingMs: 5_400_000,
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

const GIT_REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MAX_VALUE_CHARS = 255;

export function isGitRefName(value: string): boolean {
  return (
    value.length <= MAX_VALUE_CHARS &&
    GIT_REF_NAME.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock")
  );
}

export function isModelName(value: string): boolean {
  return value.length <= MAX_VALUE_CHARS && MODEL_NAME.test(value);
}
