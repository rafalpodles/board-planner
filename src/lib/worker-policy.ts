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
//
// Merging and reviewing are deliberately absent. Both used to be booleans here, and both are now
// properties of the agent a project runs: it merges if its composition carries a Merge step, and it
// is reviewed if a Reviewed gate stands after the last step that writes. A flag beside the
// composition would describe the same decision twice, and the flag would win silently.
export const PROJECT_POLICY_DEFAULTS = {
  baseBranch: "main",
  taskTimeoutMs: 1_800_000,
  runCeilingMs: 5_400_000,
  maxDiffLines: 400,
  maxDiffFiles: 10,
  model: "opus",
  fallbackModel: "sonnet",
  reviewModel: "opus",
  installCommand: "",
  buildCommand: "",
  testCommand: "",
  workingDirectory: "",
} as const;

export const GATE_COMMAND_FIELDS = ["installCommand", "buildCommand", "testCommand"] as const;

export const POLICY_FIELD_LABELS: Record<keyof typeof PROJECT_POLICY_DEFAULTS, string> = {
  baseBranch: "Base branch",
  taskTimeoutMs: "Timeout for one step (ms)",
  runCeilingMs: "Timeout for the whole run (ms)",
  maxDiffLines: "Largest diff (lines)",
  maxDiffFiles: "Largest diff (files)",
  model: "Model",
  fallbackModel: "Fallback model",
  reviewModel: "Review model",
  installCommand: "Install command",
  buildCommand: "Build command",
  testCommand: "Test command",
  workingDirectory: "Working directory",
};

// Moved onto the blocks that use them — the Size gate, the Reviewed gate, the steps' models — and
// kept only as the fallback a project pinned before agents existed. The screen no longer offers
// them, so only an instance admin may still write one; anybody who may edit the project may clear it.
export const PROJECT_POLICY_FIELDS_MOVED_TO_BLOCKS: ReadonlySet<string> = new Set([
  "maxDiffLines",
  "maxDiffFiles",
  "model",
  "fallbackModel",
  "reviewModel",
]);

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

// The three free-text policy fields do not stay data: they travel in the assignment and become
// arguments to a program on somebody's laptop — baseBranch as a revision on `git diff`, the model
// names as `--model`'s value. git reads an option-shaped positional as an option, and
// `git diff --numstat '--output=/tmp/pwned...HEAD'` exits 0 having written that file under the
// operator's own uid. Refused where an admin sets it, and again in the worker's own
// applyPolicy — a value this instance never stored can still reach a worker from somewhere else.
// Mirrored in worker/src/config.ts; server-values.contract.test.ts holds the two together.
//
// A gate command is a program to run, so it comes only from the project's owner and never from the
// checkout. No shell reads it: words split on spaces, and what a shell would act on is refused
// rather than passed along as a literal.
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

const GATE_COMMAND_WORD = /^[A-Za-z0-9._/=+:@%,~-]+$/;
const GATE_PROGRAM = /^(?:[A-Za-z0-9_][A-Za-z0-9._+-]*|\.\/[A-Za-z0-9._+/-]+)$/;
const WORKING_DIRECTORY = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
const CREDENTIAL_IN_URL = /:\/\/[^/]*@/;
const MAX_COMMAND_CHARS = 500;

export function isGateCommand(value: string): boolean {
  const [program, ...args] = value.split(/ +/);
  return (
    value.length <= MAX_COMMAND_CHARS &&
    GATE_PROGRAM.test(program) &&
    !program.split("/").includes("..") &&
    args.every((word) => GATE_COMMAND_WORD.test(word) && !CREDENTIAL_IN_URL.test(word))
  );
}

export function isWorkingDirectory(value: string): boolean {
  return value.length <= MAX_VALUE_CHARS && WORKING_DIRECTORY.test(value);
}

export const normaliseGateField = (field: string, value: string): string =>
  field === "workingDirectory" ? value.trim().replace(/\/+$/, "") : value.trim();

/** Why a gate command or working directory cannot be saved, in the words the person who typed it reads. Both consoles use it. */
export function gateFieldProblem(field: string, value: string): string | null {
  const text = normaliseGateField(field, value);
  if (!text) return null;
  if (field === "workingDirectory") {
    return isWorkingDirectory(text) ? null : "Working directory must be a path inside the repository, such as services/api, with no spaces and no part starting with a dot.";
  }
  const command = GATE_COMMAND_FIELDS.find((name) => name === field);
  if (!command || isGateCommand(text)) return null;
  return `${POLICY_FIELD_LABELS[command]} must be a program name or ./path, then its arguments. No quotes, &&, |, $ or *, and no password in a URL: for more, run a script.`;
}
