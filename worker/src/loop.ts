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
  // The assignment whose run reported the last machine fault. assignments() is stable in order, so
  // without this a project that faults on every pass keeps the head of the list and no assignment
  // behind it is ever claimed for again — starvation for as long as the fault lasts, not for one
  // pass. Starting the next pass after that project puts it last instead.
  let faultedLast: string | null = null;

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
          // Every assignment gets its own attempt and its own try/catch: a project that cannot be
          // claimed from, or a task that blows up, must not cost a sibling project its turn in this
          // pass — that would starve whichever assignment comes last in the list. A machine fault
          // is the one thing that does end the pass, because it is the machine and not the project
          // that is broken; passOrder is what keeps that from starving a sibling across passes.
          for (const projectId of passOrder(deps.assignments())) {
            if (!running) return;
            try {
              const task = await deps.api.claim(projectId, randomUUID());
              if (task) {
                if ((await deps.execute(task)) === "machine-fault") {
                  machineFault = true;
                  faultedLast = projectId;
                  break;
                }
                claimedAny = true;
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
