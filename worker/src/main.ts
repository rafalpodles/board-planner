import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { hostname } from "os";
import { dirname, join } from "path";
import { createApiClient } from "./api.js";
import { createOutbox, Store } from "./outbox.js";
import { loadConfig } from "./config.js";
import { connectControl } from "./control.js";
import { createDelivery } from "./delivery.js";
import { collectDiff } from "./diff.js";
import { createRunner } from "./exec.js";
import { createExecutor } from "./executor.js";
import { buildGates } from "./gates/index.js";
import { createLoop } from "./loop.js";
import { PipelineDeps, runTask } from "./pipeline.js";
import { createReporter } from "./reporter.js";
import { startHeartbeat } from "./registration.js";
import { createWorkspace, reapOrphans } from "./workspace.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const WORKER_VERSION = "1.0.0";

function fileStore(path: string): Store {
  return {
    read: () => (existsSync(path) ? readFileSync(path, "utf8") : ""),
    write: (text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, { mode: 0o600 });
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const runner = createRunner();
  const api = createApiClient(config);
  const workspace = createWorkspace(config, runner);

  const outbox = createOutbox(fileStore(join(config.stateDir, "outbox.jsonl")));

  const workerName = process.env.CP_WORKER_NAME?.trim();
  if (!workerName) throw new Error("CP_WORKER_NAME is required");

  const identityStore = fileStore(join(config.stateDir, "worker.json"));
  const heartbeat = startHeartbeat({
    apiBaseUrl: config.apiBaseUrl,
    apiToken: config.apiToken,
    registration: { name: workerName, host: hostname(), platform: process.platform, version: WORKER_VERSION },
    store: identityStore,
  });
  let current: AbortController | null = null;
  // Deliberately abort-only: a 403 means the server is already refusing every claim and
  // heartbeat on its own, so this needs no matching un-pause once the lock lifts.
  heartbeat.onAbort(() => current?.abort());

  const deps: PipelineDeps = {
    config,
    api,
    columnIds: () => api.columnIds(),
    createReporter: (client, statusIds) =>
      createReporter(client, statusIds, (message) => console.error(message), outbox),
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
    execute: (task) => {
      const controller = new AbortController();
      current = controller;
      return runTask({ ...deps, signal: controller.signal }, task).finally(() => {
        current = null;
      });
    },
    async drain() {
      const { delivered, pending, dropped } = await outbox.flush(api);
      if (delivered || pending || dropped) {
        console.log(`outbox: delivered ${delivered}, still pending ${pending}, dropped ${dropped}`);
      }
    },
    sleep,
  });

  // "stop" pauses rather than calling loop.stop(), which would end main() and the process with
  // it. Pausing after the abort is what stops the just-refunded task being reclaimed immediately.
  const control = connectControl({
    apiBaseUrl: config.apiBaseUrl,
    identitySource: identityStore,
    handlers: {
      pause: () => {
        loop.pause();
        if (loop.paused()) heartbeat.ack("pause");
      },
      resume: () => {
        loop.resume();
        if (!loop.paused()) heartbeat.ack("resume");
      },
      stop: () => {
        current?.abort();
        loop.pause();
        if (loop.paused()) heartbeat.ack("stop");
      },
    },
  });

  process.on("SIGTERM", () => loop.stop());
  process.on("SIGINT", () => loop.stop());

  console.log(
    `worker ${config.workerId} polling ${config.apiBaseUrl} for ${config.projectId} every ${config.pollIntervalMs}ms`
  );
  await heartbeat.tick();
  await loop.start();
  heartbeat.stop();
  control.close();
  console.log(`worker ${config.workerId} stopped`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
