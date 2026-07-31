import { spawn } from "child_process";

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
}

export interface Runner {
  run(command: string, args: string[], opts: RunOpts): Promise<CommandResult>;
}

const SIGKILL_GRACE_MS = 5000;

export function createRunner(): Runner {
  return {
    run(command, args, opts) {
      return new Promise((resolve) => {
        const child = spawn(command, args, {
          cwd: opts.cwd,
          env: opts.env ?? process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let killTimer: NodeJS.Timeout | undefined;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            child.kill("SIGKILL");
          }, SIGKILL_GRACE_MS);
        }, opts.timeoutMs);

        function clearTimers(): void {
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
        }

        child.stdout.on("data", (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });

        child.on("error", (error) => {
          clearTimers();
          resolve({ code: -1, stdout, stderr: String(error), timedOut });
        });

        child.on("close", (code) => {
          clearTimers();
          resolve({ code: code ?? -1, stdout, stderr, timedOut });
        });
      });
    },
  };
}
