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

        function clearTimers(): void {
          if (timer) clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
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
            signal: opts.signal,
          });

          timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => {
              child.kill("SIGKILL");
            }, SIGKILL_GRACE_MS);
          }, opts.timeoutMs);

          if (opts.stdin !== undefined) {
            child.stdin.on("error", () => {});
            child.stdin.end(opts.stdin);
          }

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
