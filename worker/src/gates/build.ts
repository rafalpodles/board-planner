import { CommandResult, Runner } from "../exec.js";
import { Gate } from "../types.js";

const MAX_REASON_CHARS = 2000;
// --ignore-scripts: a lifecycle script from the worktree or any dependency would run as the
// worker, outside the agent's tool allowlist and before the review gate reads a single line
const INSTALL_ARGS = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];

function outputTail(result: CommandResult): string {
  const output = [result.stdout, result.stderr].filter((stream) => stream.trim()).join("\n");
  if (output.length <= MAX_REASON_CHARS) return output;
  return `[output truncated to the last ${MAX_REASON_CHARS} characters]\n${output.slice(-MAX_REASON_CHARS)}`;
}

export function buildGate(runner: Runner, timeoutMs: number): Gate {
  return {
    name: "build",
    async run({ worktreePath, signal }) {
      const deadline = Date.now() + timeoutMs;

      // a worktree is a fresh checkout with no node_modules — skip this and every build fails with "next: command not found"
      const install = await runner.run("npm", INSTALL_ARGS, { cwd: worktreePath, timeoutMs, signal });
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
      const installMs = timeoutMs - remainingMs;
      if (remainingMs <= 0) {
        return {
          ok: false,
          reason: `the dependency install consumed the whole ${timeoutMs}ms budget — the build never started`,
        };
      }

      const build = await runner.run("npm", ["run", "build"], {
        cwd: worktreePath,
        timeoutMs: remainingMs,
        signal,
      });
      if (build.timedOut) {
        return {
          ok: false,
          reason: `build timed out after ${remainingMs}ms (dependency install took ${installMs}ms of the ${timeoutMs}ms budget)`,
        };
      }
      if (build.code !== 0) {
        return { ok: false, reason: `build failed (exit ${build.code}):\n${outputTail(build)}` };
      }
      return { ok: true, reason: "" };
    },
  };
}
