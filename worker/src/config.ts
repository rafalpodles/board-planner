import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { clampCeiling, DEFAULT_RUN_CEILING_MS } from "./budget.js";

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

export function modelOr(value: string | undefined, fallback: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed && isModelName(trimmed) ? trimmed : fallback;
}

export interface Bootstrap {
  apiBaseUrl: string;
  apiToken: string;
  enrolmentToken: string;
  enrolmentTokenFile: string;
  workerName: string;
  stateDir: string;
}

export interface EffectiveConfig {
  baseBranch: string;
  pollIntervalMs: number;
  taskTimeoutMs: number;
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
  remote: string;
  policy?: Record<string, unknown>;
}

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

export interface ProjectOffer {
  project: string;
  key: string;
  name: string;
  repositoryUrl: string;
}

export interface RepoInventory {
  remote: string;
  path: string;
}

type Env = Record<string, string | undefined>;

export type SecretReader = (path: string) => string;

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

export function stateDirFrom(env: Env): string {
  return env.CP_STATE_DIR?.trim() || join(homedir(), ".boardplanner");
}

export function loadBootstrap(env: Env, readSecret: SecretReader = readSecretFile): Bootstrap {
  return {
    apiBaseUrl: required(env, "CP_API_URL").replace(/\/$/, ""),
    apiToken: optionalSecret(env, "CP_API_TOKEN", readSecret),
    enrolmentToken: optionalSecret(env, "CP_ENROLMENT_TOKEN", readSecret),
    enrolmentTokenFile: env.CP_ENROLMENT_TOKEN_FILE?.trim() || "",
    workerName: required(env, "CP_WORKER_NAME"),
    stateDir: stateDirFrom(env),
  };
}

export const LOCAL_SOCKET_NAME = "worker.sock";

export function localSocketPath(stateDir: string): string {
  return join(stateDir, LOCAL_SOCKET_NAME);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function applyPolicy(current: EffectiveConfig, patch: unknown): EffectiveConfig {
  if (typeof patch !== "object" || patch === null) return current;
  const source = patch as Record<string, unknown>;
  const next = { ...current };

  if (isNonEmptyString(source.baseBranch) && isGitRefName(source.baseBranch.trim())) {
    next.baseBranch = source.baseBranch.trim();
  }
  if (isPositiveNumber(source.pollIntervalMs)) next.pollIntervalMs = source.pollIntervalMs;
  if (isPositiveNumber(source.taskTimeoutMs)) next.taskTimeoutMs = source.taskTimeoutMs;
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

export function parseOffers(value: unknown): ProjectOffer[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isOffer).map((offer) => ({
    project: offer.project,
    key: typeof offer.key === "string" ? offer.key : "",
    name: typeof offer.name === "string" ? offer.name : "",
    repositoryUrl: offer.repositoryUrl,
  }));
}
