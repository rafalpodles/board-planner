import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandResult, Runner, RunOpts } from "../exec.js";
import { GateResult } from "../types.js";
import { agentEnv, npmCacheOverride, tempDirOverride } from "../env.js";
import { confine, Confinement, ConfineOptions, confineTool, Network, RecordedDir, SANDBOX_COMMAND } from "../sandbox.js";
import { sealedHomesFor } from "../sealed-home.js";
import { removeTree } from "../worktree-disk.js";

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

// A project `.npmrc` is read from the worktree — committed, or left untracked by an earlier gate's
// code, where no diff sees it — and the install keeps the network. These keys are pinned for every
// command because the environment beats a project `.npmrc`, but only with a non-empty value, and
// "null" clears only a key that is not a string: a string key takes it literally.
// - git: `git=<script>` ran that script for any git dependency, --ignore-scripts or not.
// - proxy, https-proxy: with an http registry they handed the `~/.npmrc` token to the proxy.
// - node-options: npm exports it as NODE_OPTIONS, and pacote spawns `npm install --force` inside a
//   git dependency that has a prepare script, so `--require <file>` ran at that child's startup.
//   The pin is Node's default stack-trace limit, which changes nothing.
// - strict-ssl, umask: a TLS downgrade, and files written wider than the default.
// - allow-git: npm exports a project key spelled otherwise (`IGNORE_SCRIPTS`, `NODE_OPTIONS`) as
//   npm_config_<lowercased> to the child it spawns for a git dependency, over these pins, so there
//   it could turn scripts back on or name a git binary, a proxy or node options. "none" refuses
//   every git dependency before it is cloned, so that child is never spawned (BP-812). npm 10 does
//   not know the key and ignores it.
// A proxy or node-options in the operator's own `~/.npmrc` is overridden too.
export const NPM_CONFIG_PINNED = {
  npm_config_allow_git: "none",
  npm_config_git: "git",
  npm_config_proxy: "null",
  npm_config_https_proxy: "null",
  npm_config_node_options: "--stack-trace-limit=10",
  npm_config_strict_ssl: "true",
  npm_config_umask: "022",
} as const;

// A refused connection prints only `connect EPERM <address>`, which reads like a firewall
export const LOOPBACK_ONLY_NOTE = "outbound network is loopback-only under the worker";

// A refused git dependency prints only `EALLOWGIT`, which reads like the project's own setting
export const GIT_DEPENDENCIES_REFUSED_NOTE = "the worker does not install git dependencies";

export interface ConfinedNpmOptions extends RunOpts {
  /** The worktree `cwd` is, as it was recorded at creation (BP-804). */
  worktree: RecordedDir;
  /** Whether this command is the install, which is the only one allowed the cache. */
  withCache?: boolean;
  /** "loopback" for a command that runs agent-written code; the install needs the registry. */
  network?: Network;
  /**
   * The worker's own environment, for a test that needs to say what it is. Absent in production:
   * `env.ts` owns reading this process's environment, and reading it here would put a second
   * reader beside the allowlist it exists to be.
   */
  env?: NodeJS.ProcessEnv;
}

type GateRun = (CommandResult & { loopbackOnly: boolean }) | { refusal: string; replaced?: string };

/**
 * Runs one command confined to the worktree, or says why it could not be confined.
 *
 * A refusal is not a failure of the command: it means this machine cannot confine anything, which
 * is the same state `preflight` refuses to claim work in and the same sentence `confine` gives the
 * agent's own spawn. The gate reports it rather than running the command anyway — running it
 * anyway is the hole.
 */
async function runInGateSandbox(
  runner: Runner,
  options: ConfinedNpmOptions & { writable: (string | RecordedDir)[] },
  spawnFor: (confinement: ConfineOptions) => Confinement,
  envFor: (temp: string) => NodeJS.ProcessEnv
): Promise<GateRun> {
  const { withCache: _withCache, network, env: source, worktree, writable, ...runOptions } = options;

  // This run's own scratch directory, inside the machine's. Created before `confine` resolves it:
  // seatbelt matches the real path, and realpath on a directory that does not exist throws —
  // which would read as "this machine cannot confine anything". A disk that will not give us one
  // answers the same way a machine with no sandbox does, because it is the same kind of fact.
  let temp: string;
  try {
    temp = mkdtempSync(join(npmTempBase(source), "cp-gate-"));
  } catch (error) {
    return { refusal: `could not prepare a directory for this gate to write in: ${String(error)}` };
  }

  try {
    // `env` left to `confine`'s own default unless a test said otherwise, so the operator's risk
    // acceptance is read in the one place that owns it.
    const allowed = [worktree, temp, ...writable];
    const spawn = spawnFor(source ? { writable: allowed, network, env: source } : { writable: allowed, network });
    if ("refusal" in spawn) return spawn;

    // False under the escape hatch, where confine hands back a bare spawn with the network open
    const loopbackOnly = network === "loopback" && spawn.command === SANDBOX_COMMAND;
    const result = await runner.run(spawn.command, spawn.args, { ...runOptions, env: envFor(temp) });
    return result.machineFault ? { refusal: result.machineFault } : { ...result, loopbackOnly };
  } finally {
    // In a `finally`, so a removal that threw would replace the verdict: a confined command can make
    // its temp directory undeletable
    removeTree(temp);
  }
}

export async function runConfinedNpm(runner: Runner, npmPath: string, args: string[], options: ConfinedNpmOptions): Promise<GateRun> {
  const { withCache, env: source } = options;
  const cache = npmCacheDir(source);
  if (withCache) {
    try {
      mkdirSync(cache, { recursive: true, mode: 0o700 });
    } catch (error) {
      return { refusal: `could not prepare a directory for this gate to write in: ${String(error)}` };
    }
  }
  return runInGateSandbox(
    runner,
    { ...options, writable: withCache ? [cache] : [] },
    (confinement) => confineTool("npm", npmPath, args, confinement),
    // The cache location and the scratch directory travel as the child's own settings, so they
    // hold for npm and for everything it shells out to. `childEnv` is what every other spawn
    // here gets: the allowlist, and nothing of the operator's beyond it.
    (temp) => ({
      ...(source ? agentEnv([], source) : agentEnv()),
      ...NPM_CONFIG_PINNED,
      npm_config_cache: cache,
      TMPDIR: temp,
    })
  );
}

/**
 * One of a project's own commands (BP-985). The project's owner chooses it and the machine may be
 * somebody else's, so it runs with the network open and with the real home unreadable, where the npm
 * gates are the other way round. It gets the run's `gateHome` as its home: go, pip and cargo keep
 * their downloads under `HOME`, and the JVM reads `CFFIXED_USER_HOME` on macOS (with only `HOME`
 * moved Gradle dies on "Could not initialize native services") and takes its temp directory from
 * `java.io.tmpdir`, not `TMPDIR`. Not the per-account cache npm gets: that is bounded by npm checking
 * the lockfile's hashes, and pip's cache is not.
 */
export async function runConfinedProgram(
  runner: Runner,
  programPath: string,
  args: string[],
  options: Omit<ConfinedNpmOptions, "withCache" | "network"> & { home: RecordedDir; readable: string[] }
): Promise<GateRun> {
  const { home, readable, env: source, ...rest } = options;
  // Quoted: the JVM splits this on whitespace, and an operator's TMPDIR may hold a space
  return runInGateSandbox(
    runner,
    { ...rest, env: source, writable: [home] },
    (confinement) => confine(programPath, args, { ...confinement, sealedHomes: sealedHomesFor(readable, source) }),
    (temp) => ({
      ...(source ? agentEnv([], source) : agentEnv()),
      HOME: home.path,
      CFFIXED_USER_HOME: home.path,
      TMPDIR: temp,
      JAVA_TOOL_OPTIONS: `"-Djava.io.tmpdir=${temp}"`,
    })
  );
}

const MAX_REASON_CHARS = 2000;

/** The end of what a failed command printed, which is where the reason is. */
export function outputTail(result: Pick<CommandResult, "stdout" | "stderr">): string {
  const output = [result.stdout, result.stderr].filter((stream) => stream.trim()).join("\n");
  if (output.length <= MAX_REASON_CHARS) return output;
  return `[output truncated to the last ${MAX_REASON_CHARS} characters]\n${output.slice(-MAX_REASON_CHARS)}`;
}

/** A refusal as a gate reports it: the worktree swapped under it is the run's, anything else the machine's. */
export function refused(refusal: { refusal: string; replaced?: string }): GateResult {
  return refusal.replaced
    ? { ok: false, reason: refusal.refusal, tampered: `its directory ${refusal.replaced}` }
    : { ok: false, reason: refusal.refusal, machineFault: true };
}
