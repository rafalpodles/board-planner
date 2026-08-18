import { WorkerConfig } from "../config.js";

/**
 * A whole WorkerConfig, so a test never has to cast one into existence.
 *
 * The policy fields — model, fallbackModel, reviewModel — are left unset on purpose: they are the
 * only optional members of WorkerConfig, and a test that checks what the executor does without them
 * has to be able to say so. Everything else is required, and a cast that hid nine missing required
 * fields would keep type-checking on the day one of them starts being read, handing the code
 * `undefined` while the suite stayed green.
 */
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
