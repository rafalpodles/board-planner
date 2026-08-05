import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// The shape workspace.ts, executor.ts, gates/index.ts, loop.ts and pipeline.ts run against for one
// task: Bootstrap's connection details plus the current EffectiveConfig policy plus one assignment's
// bound repository. main.ts assembles it at runtime; nothing loads it from the environment anymore.
export interface WorkerConfig {
  autoMerge: boolean;
  apiBaseUrl: string;
  apiToken: string;
  repoPath: string;
  worktreeRoot: string;
  stateDir: string;
  baseBranch: string;
  pollIntervalMs: number;
  taskTimeoutMs: number;
  maxDiffLines: number;
  maxDiffFiles: number;
  workerId: string;
  model?: string;
  fallbackModel?: string;
  reviewModel?: string;
}

export const DEFAULT_MODEL = "opus";
export const DEFAULT_FALLBACK_MODEL = "sonnet";
export const DEFAULT_REVIEW_MODEL = "opus";

// Unset or blank means today's model, never `--model ""` — measured: the CLI answers
// `400 model: String should have at least 1 character`, so a blank setting would fail every run
export function modelOr(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

// What a worker needs before it can even register: where the server is, how to authenticate to it
// once, a name to register under, and where to keep the identity that registration mints. Everything
// else — project, repository, timing, diff caps — is no longer the operator's to set at boot.
export interface Bootstrap {
  apiBaseUrl: string;
  /** @deprecated CP-237: nothing reads this. Every call travels on the worker credential. */
  apiToken: string;
  // Single-use, spent by the first registration. Empty once the operator has removed it, which is
  // the intended end state — an enrolled worker never needs it again.
  enrolmentToken: string;
  enrolmentTokenFile: string;
  workerName: string;
  stateDir: string;
}

// Mirrors the server's WorkerPolicy (src/types/index.ts): worker-wide settings an instance or
// project admin edits in /settings/workers, never the laptop's own environment.
export interface EffectiveConfig {
  autoMerge: boolean;
  baseBranch: string;
  pollIntervalMs: number;
  taskTimeoutMs: number;
  maxDiffLines: number;
  maxDiffFiles: number;
  model: string;
  fallbackModel: string;
  reviewModel: string;
}

export const DEFAULT_POLICY: EffectiveConfig = {
  // Off by default, deliberately: a worker nobody has configured pushes a branch and opens a pull
  // request, and stops there. Merging is a thing an operator turns on.
  autoMerge: false,
  baseBranch: "main",
  pollIntervalMs: 30_000,
  taskTimeoutMs: 1_800_000,
  maxDiffLines: 400,
  maxDiffFiles: 10,
  model: DEFAULT_MODEL,
  fallbackModel: DEFAULT_FALLBACK_MODEL,
  reviewModel: DEFAULT_REVIEW_MODEL,
};

export interface Assignment {
  project: string;
  // The remote this worker itself reported. It resolves back to a local checkout through the
  // worker's own inventory, so the server never names a directory on this machine.
  remote: string;
  policy?: Record<string, unknown>;
}

// What this machine tells the server it has. Built from repos.json, which stays the only thing that
// decides where anything may run.
export interface RepoInventory {
  remote: string;
  path: string;
}

type Env = Record<string, string | undefined>;

export type SecretReader = (path: string) => string;

// launchd plists live at 0644 and ride along into Time Machine, so a token belongs in a file the
// worker refuses to read unless only its owner can
function readSecretFile(path: string): string {
  const mode = statSync(path).mode & 0o077;
  if (mode !== 0) {
    throw new Error(
      `${path} is readable by group or others (mode ${(statSync(path).mode & 0o777).toString(8)}); run chmod 600 on it`
    );
  }
  return readFileSync(path, "utf8");
}

function requiredSecret(env: Env, key: string, readSecret: SecretReader): string {
  const inline = env[key];
  if (inline?.trim()) return inline.trim();

  const path = env[`${key}_FILE`];
  if (path?.trim()) {
    const value = readSecret(path.trim()).trim();
    if (value) return value;
    throw new Error(`${key}_FILE points at an empty file`);
  }

  throw new Error(`${key} or ${key}_FILE is required`);
}

// Optional by design: once a worker has an identity it never registers again, so the operator is
// meant to delete this. Requiring it would stop an enrolled worker from booting.
function optionalSecret(env: Env, key: string, readSecret: SecretReader): string {
  const inline = env[key];
  if (inline?.trim()) return inline.trim();

  const path = env[`${key}_FILE`];
  if (!path?.trim()) return "";
  try {
    return readSecret(path.trim()).trim();
  } catch {
    return "";
  }
}

function required(env: Env, key: string): string {
  const value = env[key];
  if (!value || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

export function loadBootstrap(env: Env, readSecret: SecretReader = readSecretFile): Bootstrap {
  return {
    apiBaseUrl: required(env, "CP_API_URL").replace(/\/$/, ""),
    // Optional since CP-237: the worker holds one credential, minted by registration, whose scope
    // tracks its assignments. Still read when present so an existing plist keeps booting.
    apiToken: optionalSecret(env, "CP_API_TOKEN", readSecret),
    enrolmentToken: optionalSecret(env, "CP_ENROLMENT_TOKEN", readSecret),
    enrolmentTokenFile: env.CP_ENROLMENT_TOKEN_FILE?.trim() || "",
    workerName: required(env, "CP_WORKER_NAME"),
    stateDir: env.CP_STATE_DIR?.trim() || join(homedir(), ".claudeplanner"),
  };
}

export const LOCAL_SOCKET_NAME = "worker.sock";

// The local control plane lives beside the identity and the outbox, in the one directory this
// worker already owns — see local-server.ts for why it is a socket there and not a port
export function localSocketPath(stateDir: string): string {
  return join(stateDir, LOCAL_SOCKET_NAME);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Applies whatever of the known policy fields are present and well-typed in patch, leaving
// everything else — including fields this worker does not recognise — untouched
export function applyPolicy(current: EffectiveConfig, patch: unknown): EffectiveConfig {
  if (typeof patch !== "object" || patch === null) return current;
  const source = patch as Record<string, unknown>;
  const next = { ...current };

  if (typeof source.autoMerge === "boolean") next.autoMerge = source.autoMerge;
  if (isNonEmptyString(source.baseBranch)) next.baseBranch = source.baseBranch.trim();
  if (isPositiveNumber(source.pollIntervalMs)) next.pollIntervalMs = source.pollIntervalMs;
  if (isPositiveNumber(source.taskTimeoutMs)) next.taskTimeoutMs = source.taskTimeoutMs;
  if (isPositiveNumber(source.maxDiffLines)) next.maxDiffLines = source.maxDiffLines;
  if (isPositiveNumber(source.maxDiffFiles)) next.maxDiffFiles = source.maxDiffFiles;
  if (isNonEmptyString(source.model)) next.model = source.model.trim();
  if (isNonEmptyString(source.fallbackModel)) next.fallbackModel = source.fallbackModel.trim();
  if (isNonEmptyString(source.reviewModel)) next.reviewModel = source.reviewModel.trim();

  return next;
}

function isAssignment(value: unknown): value is Assignment {
  if (typeof value !== "object" || value === null) return false;
  const { project, remote } = value as Record<string, unknown>;
  return isNonEmptyString(project) && isNonEmptyString(remote);
}

// Drops malformed entries rather than refusing the whole list — one bad assignment must not take
// every other project this worker serves down with it
export function parseAssignments(value: unknown): Assignment[] {
  return Array.isArray(value) ? value.filter(isAssignment) : [];
}
