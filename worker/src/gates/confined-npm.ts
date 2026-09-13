import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandResult, Runner, RunOpts } from "../exec.js";
import { childEnv, npmCacheOverride, tempDirOverride } from "../env.js";
import { confine } from "../sandbox.js";

/**
 * The npm gates, run where the agent's own tools already are.
 *
 * BP-349 confined both `claude` spawns, so the agent's `Write` and `Edit` can no longer reach
 * outside the worktree. The chain it described was lengthened rather than closed: an Implement step
 * writes a test file that writes `$HOME/.claude/settings.json` — inside the worktree, so the
 * sandbox permits it, and a *test*, which is exactly what the Test-presence gate asks for — and
 * then `npm test` executes it as the worker's uid, outside any profile. A later Implement step in
 * the same sequence loads the hook. `Implement → Test → Implement` is an ordinary agent (BP-608).
 *
 * ## What each command may write
 *
 * - the worktree, always: `npm ci` writes `node_modules` into it, and honest suites write fixtures,
 *   snapshots and coverage there;
 * - a temp directory of its own, always: a suite that writes nowhere but the repository is the
 *   exception, and a confinement that breaks honest tests is a confinement somebody switches off.
 *   Its own, and not the machine's `TMPDIR`: allowing that whole tree would permit everything any
 *   process of this user has left under `/var/folders`, and the child is told about it through
 *   `TMPDIR`, which is where `os.tmpdir()`, `mktemp` and Python all look. Removed when the command
 *   ends, so nothing leaks from one run into the next;
 * - the npm cache, on the install only. `npm test` and `npm run build` do not need it, and
 *   `npm test` is the one that runs the agent's code.
 *
 * ## The cache, which is the decision this ticket had to take
 *
 * `~/.npm/_cacache` is the operator's own, outside the worktree, and allowing it would re-open a
 * directory an agent could then poison for every later run on the machine — including runs of
 * other projects, and including whatever the operator installs by hand. So the install gets a
 * **per-account cache** instead (`npm_config_cache`), under the system temp directory and named
 * for the uid, or wherever `CP_NPM_CACHE` says. Per account and not per worker: two workers the
 * same operator runs share it, which is the same sentence as the blast radius below.
 *
 * The blast radius that leaves, stated rather than implied: the cache is shared between runs on
 * this machine, so a package an agent can get written into it is one a later run can install. npm
 * verifies tarball integrity against the lockfile's hashes, which bounds what a poisoned entry can
 * become; "cannot be written" would be a stronger claim and is not the one made here. What is
 * closed is the operator's own cache, their shell profile, their launch agents and their
 * `~/.claude`.
 */
export function npmCacheDir(env?: NodeJS.ProcessEnv): string {
  const configured = env ? (env.CP_NPM_CACHE?.trim() ?? "") : npmCacheOverride();
  if (configured) return configured;
  // Named for the uid so two accounts on one machine do not share a cache by accident. That is a
  // separation, not a defence, and the difference is worth stating: `tmpdir()` is world-writable
  // where `TMPDIR` is unset (a daemon context, or Linux under the escape hatch), another local
  // user can create this directory first, and `mkdirSync(..., { mode })` applies its mode only to
  // a directory it creates — so an existing one is used as it is. What bounds that is npm checking
  // what it installs against the lockfile, not this name. An operator who needs more points
  // `CP_NPM_CACHE` at a directory they own (found in review).
  return join(tmpdir(), `cp-npm-cache-${typeof process.getuid === "function" ? process.getuid() : "0"}`);
}

/** The directory this machine keeps temporary files in — the parent of the one each run gets. */
export function npmTempBase(env?: NodeJS.ProcessEnv): string {
  return (env ? (env.TMPDIR?.trim() ?? "") : tempDirOverride()) || tmpdir();
}

export interface ConfinedNpmOptions extends RunOpts {
  /** Whether this command is the install, which is the only one allowed the cache. */
  withCache?: boolean;
  /**
   * The worker's own environment, for a test that needs to say what it is. Absent in production:
   * `env.ts` owns reading this process's environment, and reading it here would put a second
   * reader beside the allowlist it exists to be.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs one npm command confined to the worktree, or says why it could not be confined.
 *
 * A refusal is not a failure of the command: it means this machine cannot confine anything, which
 * is the same state `preflight` refuses to claim work in and the same sentence `confine` gives the
 * agent's own spawn. The gate reports it rather than running the command anyway — running it
 * anyway is the hole.
 */
export async function runConfinedNpm(
  runner: Runner,
  args: string[],
  options: ConfinedNpmOptions
): Promise<CommandResult | { refusal: string }> {
  const { withCache, env: source, ...runOptions } = options;
  const cache = npmCacheDir(source);

  // This run's own scratch directory, inside the machine's. Created before `confine` resolves it:
  // seatbelt matches the real path, and realpath on a directory that does not exist throws —
  // which would read as "this machine cannot confine anything". A disk that will not give us one
  // answers the same way a machine with no sandbox does, because it is the same kind of fact.
  let temp: string;
  try {
    temp = mkdtempSync(join(npmTempBase(source), "cp-gate-"));
    if (withCache) mkdirSync(cache, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { refusal: `could not prepare a directory for this gate to write in: ${String(error)}` };
  }

  const writable = [options.cwd, temp];
  if (withCache) writable.push(cache);

  try {
    // `env` left to `confine`'s own default unless a test said otherwise, so the operator's risk
    // acceptance is read in the one place that owns it.
    const spawn = confine("npm", args, source ? { writable, env: source } : { writable });
    if ("refusal" in spawn) return spawn;

    return await runner.run(spawn.command, spawn.args, {
      ...runOptions,
      // The cache location and the scratch directory travel as the child's own settings, so they
      // hold for npm and for everything it shells out to. `childEnv` is what every other spawn
      // here gets: the allowlist, and nothing of the operator's beyond it.
      env: {
        ...(source ? childEnv([], source) : childEnv()),
        npm_config_cache: cache,
        TMPDIR: temp,
      },
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
