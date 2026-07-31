import { createApiClient } from "./api.js";
import { loadConfig } from "./config.js";
import { createDelivery } from "./delivery.js";
import { collectDiff } from "./diff.js";
import { createRunner } from "./exec.js";
import { createExecutor } from "./executor.js";
import { buildGates } from "./gates/index.js";
import { createLoop } from "./loop.js";
import { PipelineDeps, runTask } from "./pipeline.js";
import { createReporter } from "./reporter.js";
import { createWorkspace, reapOrphans } from "./workspace.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const runner = createRunner();
  const api = createApiClient(config);
  const workspace = createWorkspace(config, runner);

  const deps: PipelineDeps = {
    config,
    api,
    columnIds: () => api.columnIds(),
    createReporter,
    createDelivery,
    workspace,
    executor: createExecutor(config, runner),
    collectDiff,
    runner,
    gates: buildGates(config, runner),
  };

  const reaped = await reapOrphans(workspace, config.worktreeRoot);
  if (reaped > 0) {
    console.log(`reaped ${reaped} worktree(s) left by an earlier run`);
  }

  const loop = createLoop({
    config,
    api,
    execute: (task) => runTask(deps, task),
    sleep,
  });

  process.on("SIGTERM", () => loop.stop());
  process.on("SIGINT", () => loop.stop());

  console.log(
    `worker ${config.workerId} polling ${config.apiBaseUrl} for ${config.projectId} every ${config.pollIntervalMs}ms`
  );
  await loop.start();
  console.log(`worker ${config.workerId} stopped`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
