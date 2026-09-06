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
  onStdout?: (chunk: string) => void;
}

export interface Runner {
  run(command: string, args: string[], opts: RunOpts): Promise<CommandResult>;
}

const SIGKILL_GRACE_MS = 5000;
const STDIO_DRAIN_GRACE_MS = 200;

export function killGroup(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: NodeJS.Signals
): void {
  const { pid } = child;
  if (!pid || pid < 0) {
    child.kill(signal);
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch (error) {
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
          const child = spawn(command, args, {
            cwd: opts.cwd,
            env: opts.env ?? childEnv(),
            stdio: ["pipe", "pipe", "pipe"],
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

          child.stdin.on("error", () => {});
          child.stdin.end(opts.stdin);

          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");

          child.stdout.on("data", (chunk: Buffer | string) => {
            const text = chunk.toString();
            stdout += text;
            if (!opts.onStdout) return;
            try {
              opts.onStdout(text);
            } catch {
            }
          });
          child.stderr.on("data", (chunk: Buffer | string) => {
            stderr += chunk.toString();
          });

          child.on("error", (error) => {
            settle({ code: -1, stdout, stderr: String(error), timedOut });
          });

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
