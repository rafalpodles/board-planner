import { randomUUID } from "crypto";
import { ApiClient, ClaimRefused } from "./api.js";
import { ClaimedTask } from "./types.js";

export interface LoopDeps {
  pollIntervalMs: () => number;
  assignments: () => string[];
  api: ApiClient;
  execute: (task: ClaimedTask) => Promise<void | "machine-fault">;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  drain?: () => Promise<void>;
  log?: (message: string) => void;
}

export interface Loop {
  start(): Promise<void>;
  stop(): void;
  pause(): void;
  resume(): void;
  paused(): boolean;
  unclaimable(projectId: string): string;
}

export function createLoop(deps: LoopDeps): Loop {
  const log = deps.log ?? ((message: string) => console.error(message));
  const stopping = new AbortController();
  let running = true;
  let pausedState = false;
  let faultedLast: string | null = null;
  const refused = new Map<string, string>();

  function passOrder(assignments: string[]): string[] {
    const at = faultedLast === null ? -1 : assignments.indexOf(faultedLast);
    if (at < 0) return assignments;
    return [...assignments.slice(at + 1), ...assignments.slice(0, at + 1)];
  }

  return {
    async start() {
      while (running) {
        let claimedAny = false;
        let machineFault = false;

        if (deps.drain) {
          try {
            await deps.drain();
          } catch (error) {
            log(`worker cycle failed: ${String(error)}`);
          }
        }

        if (!pausedState) {
          for (const projectId of passOrder(deps.assignments())) {
            if (!running) return;
            try {
              const task = await deps.api.claim(projectId, randomUUID());
              if (refused.delete(projectId)) log(`project ${projectId} can be claimed from again`);
              if (task) {
                if ((await deps.execute(task)) === "machine-fault") {
                  machineFault = true;
                  faultedLast = projectId;
                  break;
                }
                claimedAny = true;
              }
            } catch (error) {
              if (error instanceof ClaimRefused) {
                if (refused.get(projectId) !== error.message) {
                  refused.set(projectId, error.message);
                  log(`not claiming for project ${projectId}: ${error.message}`);
                }
              } else {
                log(`worker cycle failed for ${projectId}: ${String(error)}`);
              }
            }
          }
        }

        if (!running) return;
        if (claimedAny && !machineFault) continue;
        await deps.sleep(deps.pollIntervalMs(), stopping.signal);
      }
    },

    stop() {
      running = false;
      stopping.abort();
    },

    pause() {
      pausedState = true;
    },

    resume() {
      pausedState = false;
    },

    paused() {
      return pausedState;
    },

    unclaimable(projectId) {
      return refused.get(projectId) ?? "";
    },
  };
}
