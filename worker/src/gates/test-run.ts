import { CommandResult, Runner } from "../exec.js";
import { Gate } from "../types.js";
import { runConfinedNpm } from "./confined-npm.js";

const MAX_REASON_CHARS = 2000;

function outputTail(result: CommandResult): string {
  const output = [result.stdout, result.stderr].filter((stream) => stream.trim()).join("\n");
  if (output.length <= MAX_REASON_CHARS) return output;
  return `[output truncated to the last ${MAX_REASON_CHARS} characters]\n${output.slice(-MAX_REASON_CHARS)}`;
}

export function testRunGate(runner: Runner, timeoutMs: number): Gate {
  return {
    name: "test-run",
    async run({ worktreePath, signal }) {
      // Confined, because this is the command that runs the agent's own code: a test file the
      // Implement step wrote is inside the worktree, so the agent's sandbox permitted writing it,
      // and this is where it executes (BP-608).
      const result = await runConfinedNpm(runner, ["test"], { cwd: worktreePath, timeoutMs, signal });
      // machineFault, not a plain refusal, and the same call the review gate makes: a machine that
      // cannot confine has judged nothing, so reporting it as the suite failing would blame the
      // diff, spend the attempt and push the branch.
      if ("refusal" in result) {
        return { ok: false, reason: result.refusal, machineFault: true };
      }

      if (result.timedOut) {
        return { ok: false, reason: `the test suite timed out after ${timeoutMs}ms` };
      }
      if (result.code !== 0) {
        return {
          ok: false,
          reason: `the test suite failed (exit ${result.code}):\n${outputTail(result)}`,
        };
      }
      return { ok: true, reason: "", commands: ["npm test"] };
    },
  };
}
