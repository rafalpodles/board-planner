import { randomUUID } from "crypto";
import { ApiClient } from "./api.js";
import { WorkerConfig } from "./config.js";
import { ClaimedTask } from "./types.js";

export interface LoopDeps {
  config: WorkerConfig;
  api: ApiClient;
  execute: (task: ClaimedTask) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface Loop {
  start(): Promise<void>;
  stop(): void;
}

export function createLoop(deps: LoopDeps): Loop {
  const log = deps.log ?? ((message: string) => console.error(message));
  let running = true;

  return {
    async start() {
      while (running) {
        try {
          const task = await deps.api.claim(randomUUID());
          if (task) {
            await deps.execute(task);
            continue;
          }
        } catch (error) {
          // runTask reports its own failures to the board, so anything reaching here is the
          // worker itself breaking — the next cycle is the only recovery available
          log(`worker cycle failed: ${String(error)}`);
        }
        if (!running) return;
        await deps.sleep(deps.config.pollIntervalMs);
      }
    },

    stop() {
      running = false;
    },
  };
}
