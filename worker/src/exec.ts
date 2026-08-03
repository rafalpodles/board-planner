import { ChildProcess, spawn } from "child_process";
import { childEnv } from "./env.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOpts {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stdin?: string;
  // Observing only, and only additive: CommandResult.stdout still carries every chunk this saw, so
  // nothing downstream reads a different output because an observer was attached. Without it the
  // whole run is invisible until it ends, which for a 30-minute task is the entire point missed.
  onStdout?: (chunk: string) => void;
}

export interface Runner {
  run(command: string, args: string[], opts: RunOpts): Promise<CommandResult>;
}

const SIGKILL_GRACE_MS = 5000;
const STDIO_DRAIN_GRACE_MS = 200;

// Every child below is spawned into a process group of its own, so -pid reaches the git, npm and
// test runners `claude -p` spawns underneath itself. Signalling only the direct child leaves those
// running inside a worktree the pipeline removes the moment this run resolves.
export function killGroup(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: NodeJS.Signals
): void {
  const { pid } = child;
  // -0 is 0, which is every process in the worker's own group — the worker included. A child that
  // never spawned has no pid at all. Neither has a group of its own to signal.
  if (!pid || pid < 0) {
    child.kill(signal);
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch (error) {
    // ESRCH is the ordinary case, not a failure: the group is gone because the child exited
    // between the decision to kill it and the kill itself. Anything else falls back to the direct
    // child rather than throwing — both callers run from a timer or an abort listener, where a
    // throw is an uncaught exception that ends the worker.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH") child.kill(signal);
  }
}

export function createRunner(): Runner {
  return {
    run(command, args, opts) {
      return new Promise((resolve) => {
        let settled = false;
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        let killTimer: NodeJS.Timeout | undefined;
        let drainTimer: NodeJS.Timeout | undefined;
        let onAbort: (() => void) | undefined;

        function clearTimers(): void {
          if (timer) clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          if (drainTimer) clearTimeout(drainTimer);
          if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
        }

        function settle(result: CommandResult): void {
          if (settled) return;
          settled = true;
          clearTimers();
          resolve(result);
        }

        try {
          // spawn's own `signal` option is deliberately not used: it rejects the moment abort() is
          // called, leaving a child that ignores SIGTERM alive inside the worktree the pipeline is
          // about to remove. An abort escalates on the same path a timeout does.
          const child = spawn(command, args, {
            cwd: opts.cwd,
            env: opts.env ?? childEnv(),
            stdio: ["pipe", "pipe", "pipe"],
            // Makes the child a process group leader so killGroup has a group to reach. Never
            // unref'd to go with it: the promise settles off this child's own exit, which the
            // event loop still has to stay alive to hear. stdio stays piped, so detaching costs
            // the child only its controlling terminal, which nothing here was reading anyway.
            detached: true,
          });

          let terminating = false;
          function terminate(): void {
            if (terminating) return;
            terminating = true;
            killGroup(child, "SIGTERM");
            killTimer = setTimeout(() => killGroup(child, "SIGKILL"), SIGKILL_GRACE_MS);
          }

          timer = setTimeout(() => {
            timedOut = true;
            terminate();
          }, opts.timeoutMs);

          if (opts.signal?.aborted) {
            terminate();
          } else if (opts.signal) {
            onAbort = terminate;
            opts.signal.addEventListener("abort", onAbort, { once: true });
          }

          // stdio is "pipe" for stdin too, so it must always be ended — otherwise a child that
          // reads it to EOF hangs until timeoutMs, where "ignore" used to give instant EOF
          child.stdin.on("error", () => {});
          child.stdin.end(opts.stdin);

          // Without this a multibyte character split across a 64KB pipe boundary decodes to two
          // replacement characters — in the accumulated stdout the run is classified from, not just
          // in what an observer sees
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");

          child.stdout.on("data", (chunk: Buffer | string) => {
            const text = chunk.toString();
            stdout += text;
            if (!opts.onStdout) return;
            try {
              opts.onStdout(text);
            } catch {
              // this runs inside a stream handler, where a throw is an uncaught exception that
              // takes the whole worker down — watching a run must not be able to end it
            }
          });
          child.stderr.on("data", (chunk: Buffer | string) => {
            stderr += chunk.toString();
          });

          child.on("error", (error) => {
            settle({ code: -1, stdout, stderr: String(error), timedOut });
          });

          // "close" also waits for stdout/stderr EOF, which never comes if a grandchild inherited
          // these pipes and outlives this child (e.g. a gate's npm spawning its own children).
          // Settle on "exit" instead, giving "close" a short window to still land the full output.
          child.on("exit", (code) => {
            if (settled) return;
            drainTimer = setTimeout(() => {
              settle({ code: code ?? -1, stdout, stderr, timedOut });
            }, STDIO_DRAIN_GRACE_MS);
          });

          child.on("close", (code) => {
            settle({ code: code ?? -1, stdout, stderr, timedOut });
          });
        } catch (error) {
          settle({ code: -1, stdout: "", stderr: String(error), timedOut: false });
        }
      });
    },
  };
}
