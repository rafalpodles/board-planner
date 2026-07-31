import { CommandResult, Runner } from "../exec.js";
import { Gate } from "../types.js";

const MAX_REASON_CHARS = 2000;
const INSTALL_ARGS = ["ci", "--no-audit", "--no-fund"];

function outputTail(result: CommandResult): string {
  const output = [result.stdout, result.stderr].filter((stream) => stream.trim()).join("\n");
  if (output.length <= MAX_REASON_CHARS) return output;
  return `[output truncated to the last ${MAX_REASON_CHARS} characters]\n${output.slice(-MAX_REASON_CHARS)}`;
}

export function buildGate(runner: Runner, timeoutMs: number): Gate {
  return {
    name: "build",
    async run({ worktreePath }) {
      const deadline = Date.now() + timeoutMs;

      // a worktree is a fresh checkout with no node_modules — skip this and every build fails with "next: command not found"
      const install = await runner.run("npm", INSTALL_ARGS, { cwd: worktreePath, timeoutMs });
      if (install.timedOut) {
        return { ok: false, reason: `dependency install timed out after ${timeoutMs}ms` };
      }
      if (install.code !== 0) {
        return {
          ok: false,
          reason: `dependency install failed (exit ${install.code}):\n${outputTail(install)}`,
        };
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return { ok: false, reason: `build timed out after ${timeoutMs}ms` };
      }

      const build = await runner.run("npm", ["run", "build"], {
        cwd: worktreePath,
        timeoutMs: remainingMs,
      });
      if (build.timedOut) {
        return { ok: false, reason: `build timed out after ${timeoutMs}ms` };
      }
      if (build.code !== 0) {
        return { ok: false, reason: `build failed (exit ${build.code}):\n${outputTail(build)}` };
      }
      return { ok: true, reason: "" };
    },
  };
}
