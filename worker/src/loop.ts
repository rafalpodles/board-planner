import { randomUUID } from "crypto";
import { ApiClient } from "./api.js";
import { ClaimedTask } from "./types.js";

export interface LoopDeps {
  pollIntervalMs: () => number;
  // The project ids currently claimable, read fresh on every pass — a worker may serve more than
  // one project, and an admin can add or remove an assignment while this loop is already running
  assignments: () => string[];
  api: ApiClient;
  // "machine-fault" says the run failed for a reason that has nothing to do with the task and will
  // repeat on the next one — an unreachable remote, say. Claiming onward would walk the whole
  // approved queue through a failure none of those tasks caused, so the pass ends and the worker
  // waits out its poll interval instead.
  execute: (task: ClaimedTask) => Promise<void | "machine-fault">;
  // The signal is aborted by stop(); a sleep that ignores it delays every shutdown by up to a full
  // poll interval, which at the default 30 s outlasts launchd's 20 s exit timeout
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  // Undelivered reports go out before new work is claimed: a stranded task from the last cycle
  // matters more than starting another one
  drain?: () => Promise<void>;
  log?: (message: string) => void;
}

export interface Loop {
  start(): Promise<void>;
  stop(): void;
  pause(): void;
  resume(): void;
  paused(): boolean;
}

export function createLoop(deps: LoopDeps): Loop {
  const log = deps.log ?? ((message: string) => console.error(message));
  const stopping = new AbortController();
  let running = true;
  let pausedState = false;

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
          // Every assignment gets its own attempt and its own try/catch, in order: a project that
          // cannot be claimed from, or a task that blows up, must not cost a sibling project its
          // turn in this pass — that would starve whichever assignment comes last in the list.
          for (const projectId of deps.assignments()) {
            if (!running) return;
            if (machineFault) break;
            try {
              const task = await deps.api.claim(projectId, randomUUID());
              if (task) {
                if ((await deps.execute(task)) === "machine-fault") machineFault = true;
                else claimedAny = true;
              }
            } catch (error) {
              // runTask reports its own failures to the board, so anything reaching here is the
              // worker itself breaking — the next pass is the only recovery available
              log(`worker cycle failed for ${projectId}: ${String(error)}`);
            }
          }
        }

        if (!running) return;
        // A machine fault outranks work done earlier in the pass: the fault is what the next claim
        // would hit, so the pass ends here whatever else succeeded before it.
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
  };
}
