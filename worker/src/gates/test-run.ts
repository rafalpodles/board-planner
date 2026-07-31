import { CommandResult, Runner } from "../exec.js";
import { Gate } from "../types.js";

const MAX_REASON_CHARS = 2000;

function outputTail(result: CommandResult): string {
  const output = [result.stdout, result.stderr].filter((stream) => stream.trim()).join("\n");
  if (output.length <= MAX_REASON_CHARS) return output;
  return `[output truncated to the last ${MAX_REASON_CHARS} characters]\n${output.slice(-MAX_REASON_CHARS)}`;
}

export function testRunGate(runner: Runner, timeoutMs: number): Gate {
  return {
    name: "test-run",
    async run({ worktreePath }) {
      const result = await runner.run("npm", ["test"], { cwd: worktreePath, timeoutMs });

      if (result.timedOut) {
        return { ok: false, reason: `the test suite timed out after ${timeoutMs}ms` };
      }
      if (result.code !== 0) {
        return {
          ok: false,
          reason: `the test suite failed (exit ${result.code}):\n${outputTail(result)}`,
        };
      }
      return { ok: true, reason: "" };
    },
  };
}
