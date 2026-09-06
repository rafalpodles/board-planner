import { WorkerConfig } from "../config.js";

export function workerConfig(over: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    apiBaseUrl: "https://app.example.com",
    apiToken: "cp_t",
    repoPath: "/repo",
    worktreeRoot: "/repo/.worktrees",
    stateDir: "/repo/.worker",
    baseBranch: "main",
    pollIntervalMs: 30_000,
    taskTimeoutMs: 1000,
    runCeilingMs: 3_600_000,
    maxDiffLines: 800,
    maxDiffFiles: 40,
    workerId: "w1",
    ...over,
  };
}
