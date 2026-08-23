import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { clampCeiling, DEFAULT_RUN_CEILING_MS } from "./budget.js";

// The shape workspace.ts, executor.ts, gates/index.ts, loop.ts and pipeline.ts run against for one
// task: Bootstrap's connection details plus the current EffectiveConfig policy plus one assignment's
// bound repository. main.ts assembles it at runtime; nothing loads it from the environment anymore.
export interface WorkerConfig {
  apiBaseUrl: string;
  apiToken: string;
  repoPath: string;
  worktreeRoot: string;
  stateDir: string;
  baseBranch: string;
  pollIntervalMs: number;
  taskTimeoutMs: number;
  runCeilingMs: number;
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

// The three free-text policy fields are each spent as an argument to a program on this machine:
// baseBranch as a revision on `git diff`, the model names as `--model`'s value. Checked where the
// value is accepted rather than at the sink, because the sink cannot tell a branch somebody chose
// from an option somebody smuggled. Mirrored in src/lib/worker-policy.ts, which refuses the same
// shapes server-side — see server-values.contract.test.ts.
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

// Unset or blank means today's model, never `--model ""` — measured: the CLI answers
// `400 model: String should have at least 1 character`, so a blank setting would fail every run.
// The same fallback covers a value that is not a model name: the step and the review gate both
// carry their own override (SnapshotEntry.model, the review gate's `model` param), and neither
// travels through applyPolicy, so this is where all three meet.
export function modelOr(value: string | undefined, fallback: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed && isModelName(trimmed) ? trimmed : fallback;
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
  baseBranch: string;
  pollIntervalMs: number;
  taskTimeoutMs: number;
  // taskTimeoutMs bounds one model call. A composed agent makes several, so this bounds the run.
  runCeilingMs: number;
  maxDiffLines: number;
  maxDiffFiles: number;
  model: string;
  fallbackModel: string;
  reviewModel: string;
}

export const DEFAULT_POLICY: EffectiveConfig = {
  baseBranch: "main",
  pollIntervalMs: 30_000,
  taskTimeoutMs: 1_800_000,
  runCeilingMs: DEFAULT_RUN_CEILING_MS,
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

// One row of the catalogue: every project this machine's owner can reach, with the state that
// decides what the app does about it. `wanted` is the operator's choice, `servedHere` is what the
// disk says; the difference between them is the work.
export interface ProjectCatalogueEntry {
  project: string;
  key: string;
  name: string;
  repositoryUrl: string;
  available: boolean;
  workersEnabled: boolean;
  servedHere: boolean;
  wanted: boolean;
}

// A project this machine could serve if it had the checkout — enabled, reachable by its owner, and
// naming a repository. The app renders these as the projects you can add; nothing here is claimed
// or bound until a checkout exists and repos.json grants it.
export interface ProjectOffer {
  project: string;
  key: string;
  name: string;
  repositoryUrl: string;
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

// Resolvable before anything else is: `--preflight` runs on a machine that has not enrolled yet,
// with none of the variables loadBootstrap insists on, and it still has to find the state
// directory to read the operator's pinned GitHub account out of.
export function stateDirFrom(env: Env): string {
  return env.CP_STATE_DIR?.trim() || join(homedir(), ".boardplanner");
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
    stateDir: stateDirFrom(env),
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

  // Dropped like any other malformed field rather than refusing the whole patch: one project
  // sending a value this worker will not run must not cost the machine the others it serves.
  if (isNonEmptyString(source.baseBranch) && isGitRefName(source.baseBranch.trim())) {
    next.baseBranch = source.baseBranch.trim();
  }
  if (isPositiveNumber(source.pollIntervalMs)) next.pollIntervalMs = source.pollIntervalMs;
  if (isPositiveNumber(source.taskTimeoutMs)) next.taskTimeoutMs = source.taskTimeoutMs;
  // Clamped, not taken: a ceiling past the server's own lease gets the task reclaimed under a
  // running worker, and the abort that follows reads as the machine dying.
  next.runCeilingMs = clampCeiling(
    isPositiveNumber(source.runCeilingMs) ? source.runCeilingMs : current.runCeilingMs
  );
  if (isPositiveNumber(source.maxDiffLines)) next.maxDiffLines = source.maxDiffLines;
  if (isPositiveNumber(source.maxDiffFiles)) next.maxDiffFiles = source.maxDiffFiles;
  if (isNonEmptyString(source.model) && isModelName(source.model.trim())) {
    next.model = source.model.trim();
  }
  if (isNonEmptyString(source.fallbackModel) && isModelName(source.fallbackModel.trim())) {
    next.fallbackModel = source.fallbackModel.trim();
  }
  if (isNonEmptyString(source.reviewModel) && isModelName(source.reviewModel.trim())) {
    next.reviewModel = source.reviewModel.trim();
  }

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

function isOffer(value: unknown): value is ProjectOffer {
  if (typeof value !== "object" || value === null) return false;
  const { project, repositoryUrl } = value as Record<string, unknown>;
  return isNonEmptyString(project) && isNonEmptyString(repositoryUrl);
}

function isCatalogueEntry(value: unknown): value is ProjectCatalogueEntry {
  if (typeof value !== "object" || value === null) return false;
  return isNonEmptyString((value as Record<string, unknown>).project);
}

// Booleans read as `=== true` rather than for truthiness: a missing `wanted` from an older server
// must mean "not chosen", and a missing `servedHere` must not read as "connected". Both mistakes
// end with the app deleting a checkout nobody asked it to touch.
export function parseCatalogue(value: unknown): ProjectCatalogueEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isCatalogueEntry).map((row) => {
    const r = row as unknown as Record<string, unknown>;
    return {
      project: String(r.project),
      key: typeof r.key === "string" ? r.key : "",
      name: typeof r.name === "string" ? r.name : "",
      repositoryUrl: typeof r.repositoryUrl === "string" ? r.repositoryUrl : "",
      available: r.available === true,
      workersEnabled: r.workersEnabled === true,
      servedHere: r.servedHere === true,
      wanted: r.wanted === true,
    };
  });
}

// Same forgiveness as the assignments above, and for a smaller stake: a malformed entry here costs
// one row in a list the operator is reading, never a project that stops being served.
export function parseOffers(value: unknown): ProjectOffer[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isOffer).map((offer) => ({
    project: offer.project,
    key: typeof offer.key === "string" ? offer.key : "",
    name: typeof offer.name === "string" ? offer.name : "",
    repositoryUrl: offer.repositoryUrl,
  }));
}
