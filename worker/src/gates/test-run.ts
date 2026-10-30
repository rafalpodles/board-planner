import { CommandResult, Runner } from "../exec.js";
import { Gate } from "../types.js";
import { LOOPBACK_ONLY_NOTE, refused, runConfinedNpm } from "./confined-npm.js";
import { gateDirectory, GateCommands, NPM_GATES, runOwnTests, usesOwnCommands } from "./gate-commands.js";

const MAX_REASON_CHARS = 2000;

function outputTail(result: CommandResult): string {
  const output = [result.stdout, result.stderr].filter((stream) => stream.trim()).join("\n");
  if (output.length <= MAX_REASON_CHARS) return output;
  return `[output truncated to the last ${MAX_REASON_CHARS} characters]\n${output.slice(-MAX_REASON_CHARS)}`;
}

export function testRunGate(runner: Runner, npmPath: string, timeoutMs: number, commands: GateCommands = NPM_GATES): Gate {
  return {
    name: "test-run",
    async run(context) {
      if (usesOwnCommands(commands)) return runOwnTests(runner, commands, timeoutMs, context);
      const { worktreeDir, signal } = context;
      const place = gateDirectory(context.worktreePath, commands.workingDirectory);
      if ("reason" in place) return { ok: false, reason: place.reason };
      // Confined, because this is the command that runs the agent's own code: a test file the
      // Implement step wrote is inside the worktree, so the agent's sandbox permitted writing it,
      // and this is where it executes (BP-608).
      const result = await runConfinedNpm(runner, npmPath, ["test"], {
        cwd: place.path,
        worktree: worktreeDir,
        timeoutMs,
        signal,
        network: "loopback",
      });
      // machineFault, not a plain refusal, and the same call the review gate makes: a machine that
      // cannot confine has judged nothing, so reporting it as the suite failing would blame the
      // diff, spend the attempt and push the branch.
      if ("refusal" in result) return refused(result);

      if (result.timedOut) {
        return { ok: false, reason: `the test suite timed out after ${timeoutMs}ms` };
      }
      if (result.code !== 0) {
        return {
          ok: false,
          reason: `the test suite failed (exit ${result.code}${result.loopbackOnly ? `; ${LOOPBACK_ONLY_NOTE}` : ""}):\n${outputTail(result)}`,
        };
      }
      return { ok: true, reason: "", commands: [commands.workingDirectory ? `npm test (in ${commands.workingDirectory})` : "npm test"] };
    },
  };
}
