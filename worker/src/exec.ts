import { spawn } from "child_process";
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
}

export interface Runner {
  run(command: string, args: string[], opts: RunOpts): Promise<CommandResult>;
}

const SIGKILL_GRACE_MS = 5000;

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
        let onAbort: (() => void) | undefined;

        function clearTimers(): void {
          if (timer) clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
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
          // about to remove. An abort escalates on the same path a timeout does, and only "close"
          // settles the promise.
          const child = spawn(command, args, {
            cwd: opts.cwd,
            env: opts.env ?? childEnv(),
            stdio: ["pipe", "pipe", "pipe"],
          });

          let terminating = false;
          function terminate(): void {
            if (terminating) return;
            terminating = true;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
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

          child.stdout.on("data", (chunk: Buffer | string) => {
            stdout += chunk.toString();
          });
          child.stderr.on("data", (chunk: Buffer | string) => {
            stderr += chunk.toString();
          });

          child.on("error", (error) => {
            settle({ code: -1, stdout, stderr: String(error), timedOut });
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
