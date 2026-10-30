import { Runner } from "../exec.js";
import { Gate } from "../types.js";
import { GIT_DEPENDENCIES_REFUSED_NOTE, LOOPBACK_ONLY_NOTE, outputTail, refused, runConfinedNpm } from "./confined-npm.js";
import { gateDirectory, GateCommands, NPM_GATES, runOwnBuild, usesOwnCommands } from "./gate-commands.js";

// --ignore-scripts: a lifecycle script from the worktree or any dependency would run as the
// worker, outside the agent's tool allowlist and before the review gate reads a single line
const INSTALL_ARGS = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];

export function buildGate(runner: Runner, npmPath: string, timeoutMs: number, commands: GateCommands = NPM_GATES): Gate {
  return {
    name: "build",
    async run(context) {
      if (usesOwnCommands(commands)) return runOwnBuild(runner, commands, timeoutMs, context);
      const { worktreeDir, signal } = context;
      const place = gateDirectory(context.worktreePath, commands.workingDirectory);
      if ("reason" in place) return { ok: false, reason: place.reason };
      const cwd = place.path;
      const deadline = Date.now() + timeoutMs;

      // a worktree is a fresh checkout with no node_modules — skip this and every build fails with "next: command not found"
      // The one command allowed the npm cache, and the reason `confined-npm.ts` has a cache at all
      const install = await runConfinedNpm(runner, npmPath, INSTALL_ARGS, {
        cwd,
        worktree: worktreeDir,
        timeoutMs,
        signal,
        withCache: true,
      });
      // machineFault: this machine has judged nothing — see the same call in test-run.ts
      if ("refusal" in install) return refused(install);
      if (install.timedOut) {
        return { ok: false, reason: `dependency install timed out after ${timeoutMs}ms` };
      }
      if (install.code !== 0) {
        const gitRefused = /\bEALLOWGIT\b/.test(install.stdout + install.stderr);
        return {
          ok: false,
          reason: `dependency install failed (exit ${install.code}${gitRefused ? `; ${GIT_DEPENDENCIES_REFUSED_NOTE}` : ""}):\n${outputTail(install)}`,
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

      // No cache: the install has already filled node_modules, and this runs the worktree's own
      // build script — agent-written, like the tests
      const build = await runConfinedNpm(runner, npmPath, ["run", "build"], {
        cwd,
        worktree: worktreeDir,
        timeoutMs: remainingMs,
        signal,
        network: "loopback",
      });
      if ("refusal" in build) return refused(build);
      if (build.timedOut) {
        return {
          ok: false,
          reason: `build timed out after ${remainingMs}ms (dependency install took ${installMs}ms of the ${timeoutMs}ms budget)`,
        };
      }
      if (build.code !== 0) {
        return { ok: false, reason: `build failed (exit ${build.code}${build.loopbackOnly ? `; ${LOOPBACK_ONLY_NOTE}` : ""}):\n${outputTail(build)}` };
      }
      const ran = [`npm ${INSTALL_ARGS.join(" ")}`, "npm run build"];
      return { ok: true, reason: "", commands: commands.workingDirectory ? ran.map((command) => `${command} (in ${commands.workingDirectory})`) : ran };
    },
  };
}
