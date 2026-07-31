import { hostname } from "os";
import { join } from "path";

export interface WorkerConfig {
  apiBaseUrl: string;
  apiToken: string;
  projectId: string;
  repoPath: string;
  worktreeRoot: string;
  baseBranch: string;
  pollIntervalMs: number;
  taskTimeoutMs: number;
  concurrency: number;
  maxDiffLines: number;
  maxDiffFiles: number;
  workerId: string;
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key];
  if (!value || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function number(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  return parsed;
}

export function loadConfig(env: Env): WorkerConfig {
  const repoPath = required(env, "CP_REPO_PATH");
  return {
    apiBaseUrl: required(env, "CP_API_URL").replace(/\/$/, ""),
    apiToken: required(env, "CP_API_TOKEN"),
    projectId: required(env, "CP_PROJECT_ID"),
    repoPath,
    worktreeRoot: env.CP_WORKTREE_ROOT?.trim() || join(repoPath, "..", "cp-worktrees"),
    baseBranch: env.CP_BASE_BRANCH?.trim() || "main",
    pollIntervalMs: number(env, "CP_POLL_INTERVAL_MS", 30_000),
    taskTimeoutMs: number(env, "CP_TASK_TIMEOUT_MS", 1_800_000),
    concurrency: number(env, "CP_CONCURRENCY", 1),
    maxDiffLines: number(env, "CP_MAX_DIFF_LINES", 400),
    maxDiffFiles: number(env, "CP_MAX_DIFF_FILES", 10),
    workerId: env.CP_WORKER_ID?.trim() || `worker-${hostname()}`,
  };
}
