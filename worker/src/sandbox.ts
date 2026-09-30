import { lstatSync, realpathSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { UNCONFINED_ESCAPE_HATCH, unconfinedAgentAllowed } from "./env.js";
import { ResolvedTool, unresolvedToolReason } from "./tool-path.js";

/**
 * Runs the agent under a kernel sandbox that cannot write outside the worktree.
 *
 * `--permission-mode bypassPermissions` is what the implementer step needs to work unattended, and
 * under it `Write` takes an absolute path anywhere the uid can reach. `HOME` is forwarded on
 * purpose (env.ts) because the CLI authenticates from its logged-in session there — so the shortest
 * escape is `$HOME/.claude/settings.json`, whose hooks run a shell command on the *next* `claude`
 * invocation. Nothing downstream can see it: the file is outside the repository, so it never
 * reaches `collectDiff` and `protected-paths` cannot match a path it is never given. `~/.zshrc`,
 * `~/Library/LaunchAgents/*.plist` and `~/.gitconfig` are the same escape with different timing.
 *
 * Not a per-run `HOME`, which is what BP-349 originally proposed. Measured on 2026-09-12: a fresh
 * home answers `Not logged in · Please run /login`, with or without a `hasCompletedOnboarding`
 * file, and there is no credential file under `~/.claude` to copy into one. It would not have been
 * enough either — moving `HOME` does not stop `/Users/<operator>/.claude/settings.json` being
 * written by name, and `USER` is on the same allowlist that forwards `HOME`.
 *
 * Writes a *daemon* performs on the process's behalf are the other half, and `file-write*` cannot
 * see them: `(allow default)` leaves `process-exec` and `mach-lookup` open, so `defaults write
 * <domain> <key> <value>` returned 0 under this profile and cfprefsd wrote the plist under
 * `~/Library/Preferences`, outside the worktree. BP-608 is what opened it — the tool allowlist used
 * to close it by giving the agent no shell, and then the npm gates moved inside this profile, where
 * a test file that spawns `defaults` is run by the Test gate. The deny on cfprefsd's two service
 * names closes it, measured on macOS 26.6: the same command answers "Could not write domain" and
 * writes nothing, while the worktree stays writable.
 *
 * What that deny costs was measured rather than assumed, because a `mach-lookup` deny is not a
 * write-only deny and the profile deliberately leaves reads alone: under it `defaults read -g` still
 * answers, `npm ci`, `npm run build` and `npm test` all exit 0 on a real package, `git` commits, and
 * `claude -p` exits 0 under both of executor.ts's `--tools` lists with no permission denial on
 * stderr. Preferences a daemon *caches* for a client are the part no measurement here covers: a
 * program that reads one only through cfprefsd sees the default instead, which for the run is the
 * same class of answer as a fresh account.
 *
 * Launching is the same shape (BP-807): `open -g -j <bundle>` returned 0 under this profile and the
 * bundle's program ran with ppid 1, unconfined. The deny below names the services a launch and an
 * AppleEvent go through, measured on macOS 26.6.2; `npm ci`, `npm run build`, `npm test`, git and
 * the executor's real `claude -p` still succeed under it.
 *
 * Still open, and it is the same shape: every other daemon reachable by `mach-lookup`. Naming
 * cfprefsd closes the channel somebody measured, not the category — a denylist of service names
 * cannot be completed, for the reason the comment above declines to denylist the instruction
 * channels in the operator's home.
 *
 * The gates are inside it too, since BP-608: `npm ci`, `npm run build` and `npm test` run
 * agent-written code — a test file is exactly what an Implement step is asked to write — and they
 * used to run as the worker's uid with nothing confining them, which made the escape above
 * reachable in two moves rather than closed. `gates/confined-npm.ts` owns what each of them may
 * write, and `gates/npm-confinement.integration.test.ts` runs a suite that tries to plant a hook.
 *
 * Children inherit it: `sandbox(7)` states that new processes inherit the sandbox of their parent,
 * and `sandbox.integration.test.ts` drives a grandchild to confirm it here.
 *
 * Measured the same day, and the limits of the measurement matter: under the profile below, and
 * with the `--tools` lists executor.ts actually passes, `claude -p` exits 0 with empty stderr and
 * no permission denials, and needs no write access to `~/.claude` or `~/.claude.json`. That is what
 * lets the allowance stay a list of directories rather than a denylist of the instruction channels
 * inside the operator's home.
 *
 * Those three signals cannot see a *tool* that fails, though — the model routes around one and
 * still reports success. Measured: with Bash in the list, its scratch root `/tmp/claude-<uid>/…`
 * is outside the worktree and not TMPDIR-derived, so every Bash call fails EPERM while the run
 * still exits 0. Neither spawn gives the agent Bash, so nothing is broken today; the claim above
 * holds for those tool lists and not for a wider one. Whoever adds a tool re-measures at the tool
 * level, because no test here runs the real CLI.
 */

// Absolute, not `sandbox-exec` on the PATH. The worker extends its own PATH with directories
// preflight resolved, and a wrapper whose job is to constrain a hostile process must not be
// findable at a name: anything earlier on that PATH would silently become the sandbox. macOS keeps
// it here; a machine where it is not gets a refusal from preflight rather than a green row.
export const SANDBOX_COMMAND = "/usr/bin/sandbox-exec";

// The operator's own risk acceptance lives in env.ts, which owns reading this process's
// environment. It means the same thing on every platform — run the agent unconfined — so there is
// one sentence to read rather than a matrix.
// The way out comes first. The fleet screen renders this row on one truncated line (BP-606), so
// whatever is at the end is what an operator never reads — and what they need is the thing to do.
export const UNCONFINED_REASON =
  `set ${UNCONFINED_ESCAPE_HATCH}=1 on this machine to run anyway, accepting that the agent could ` +
  "then write anywhere this user can: there is no sandbox here to confine it with, because seatbelt is macOS only";

/**
 * What a machine whose operator has accepted the risk says on the fleet screen. Here rather than
 * inside preflight.ts so both operator-facing sentences sit together, and so both can be held
 * against the e2e that asserts them (unconfined-reason.contract.test.ts).
 */
export const UNCONFINED_ACCEPTED_DETAIL =
  `${UNCONFINED_ESCAPE_HATCH} is set — the agent runs with nothing confining its writes and can reach anything this user can`;

/**
 * No `confined` flag. Nothing at run time consumes one, and a field that exists so a log line can
 * mention it is a second source of truth next to the preflight row. The question it would answer —
 * "was this produced by a confined agent?" — is about a *run*, read weeks later off a merged pull
 * request, and the fleet row cannot answer that because it is recomputed at boot. If it is ever
 * asked, it belongs on RunRecord beside `agentName`, which exists for exactly that reason.
 */
export type Confinement =
  | { command: string; args: string[] }
  // `replaced` when the refusal is a recorded directory that is no longer itself: the run's doing,
  // not the machine's, so it must not be accounted as a machine that cannot confine
  | { refusal: string; replaced?: string };

/** A directory as it was when the worker made it: its real path, and which directory that was. */
export interface RecordedDir {
  path: string;
  dev: number;
  ino: number;
}

export interface DirStat {
  dev: number;
  ino: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface ConfineOptions {
  /**
   * Directories the child may write to. Everything else is denied, including `$HOME`. The worktree
   * is always a `RecordedDir`: a confined step can replace the directory it was given with a
   * symlink, so a path resolved at the next spawn would be wherever that symlink points (BP-804).
   */
  writable: (string | RecordedDir)[];
  platform?: NodeJS.Platform;
  realpath?: (path: string) => string;
  lstat?: (path: string) => DirStat;
  env?: NodeJS.ProcessEnv;
  /** Defaults to "open"; "loopback" refuses every outbound connection except to this machine. */
  network?: Network;
}

/**
 * The parent is resolved and the directory itself never is. Every writable directory is a child of
 * one no confined process may write, so the parent cannot have been swapped; the leaf can, by any
 * process that was allowed it, and a leaf that is now a symlink is refused rather than followed.
 * Seatbelt matches the resolved path of each access, so a literal path that becomes a symlink after
 * this check permits nothing through it — measured on macOS 26.6.2.
 */
export function recordDir(
  path: string,
  realpath: (path: string) => string = realpathSync,
  lstat: (path: string) => DirStat = lstatSync,
): RecordedDir {
  const absolute = resolve(path);
  const real = join(realpath(dirname(absolute)), basename(absolute));
  const stat = lstat(real);
  if (stat.isSymbolicLink()) throw new Error(`${real} is a symlink, not a directory`);
  if (!stat.isDirectory()) throw new Error(`${real} is not a directory`);
  return { path: real, dev: stat.dev, ino: stat.ino };
}

/** How `dir` differs from the directory recorded, or null while it is that same directory. */
export function dirReplaced(dir: RecordedDir, lstat: (path: string) => DirStat = lstatSync): string | null {
  let stat: DirStat;
  try {
    stat = lstat(dir.path);
  } catch {
    return `${dir.path} removed`;
  }
  if (stat.isSymbolicLink()) return `${dir.path} replaced by a symlink`;
  if (!stat.isDirectory()) return `${dir.path} replaced by something that is not a directory`;
  if (stat.dev !== dir.dev || stat.ino !== dir.ino) return `${dir.path} replaced by another directory`;
  return null;
}

export type Network = "open" | "loopback";

// For the gates that run agent-written code (BP-720): reads stay open, so a test can read a
// credential under HOME, and this is what stops it sending one off the machine. SBPL accepts only
// `*` or `localhost` as a host, and `localhost` is every address this machine holds, measured on
// macOS 26.6: 127.0.0.1, ::1 and its own LAN address connect; 127.0.0.2 and another LAN host get
// EPERM. So any listener on this machine is reachable, a forwarding proxy included. Unix sockets
// stay allowed (BP-810), and with them getaddrinfo through mDNSResponder: a name still resolves,
// which is a DNS channel, while the connection to it is refused.
const LOOPBACK_ONLY = [
  "(deny network-outbound)",
  '(allow network-outbound (remote ip "localhost:*") (remote unix-socket))',
];

// `(allow default)` sets the default decision for operations the profile has no filter for. It is
// not a rule competing by position, and the order below is conventional rather than load-bearing:
// measured on macOS 26.6.2, this profile denies the outside write with `(allow default)` moved last
// AND with the deny placed after the allow-back. What IS load-bearing is that the deny exists at
// all — the same profile without it lets the write through, measured in the same run.
//
// No claim here about which rule "wins", in either direction: Apple has never published SBPL's
// semantics (`sandbox-exec(1)` documents only `-p`, and both it and `sandbox_init(3)` are marked
// deprecated), and the third-party accounts say first-match, which does not match the measurement
// above either. The measurement is the only thing this comment is willing to assert.
//
// Reads are deliberately untouched. The agent has `Read` over the disk already — scrub.ts is built
// on that being true — and confining reads would take the CLI's own session with it.
function profileFor(names: string[]): string {
  const allowWrites = names.map((name) => `(subpath (param "${name}"))`).join(" ");
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    // stream-json rides stdout, and a gate's npm redirects to the discard. Named rather than
    // `(subpath "/dev")`, which would also permit whatever else the uid can open under there.
    '(allow file-write-data (literal "/dev/null"))',
    `(allow file-write* ${allowWrites})`,
    // A write this process does not perform: `defaults write <domain> …` asks cfprefsd, which runs
    // outside the profile, and the plist lands under `~/Library/Preferences` with `file-write*`
    // denied and exit 0. Both names, because the per-user agent answers when the daemon does not.
    // Denying the lookup rather than the exec: `defaults` is one of many clients, and a denylist of
    // programs is the game sandbox.ts already refuses to play.
    '(deny mach-lookup (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent"))',
    // A process this one never spawns (BP-807): `open`, NSWorkspace and osascript ask a daemon to
    // launch an app, and it runs outside the profile with ppid 1. LaunchServices launches through
    // CoreServicesUIAgent (quarantine-resolver) and falls back to RunningBoard, so both go; lsd's
    // modifydb registers a bundle's URL handlers for a later launch; appleeventsd hands out the
    // port an AppleEvent to another app needs.
    '(deny mach-lookup (global-name "com.apple.coreservices.quarantine-resolver") (global-name "com.apple.runningboard") ' +
      '(global-name "com.apple.lsd.modifydb") (global-name "com.apple.coreservices.appleevents"))',
  ].join("\n");
}

/**
 * Wraps a spawn so it can only write under `writable`, or says why it cannot.
 *
 * Paths travel as `-D` parameters rather than as text inside the profile: a directory name
 * containing a quote would otherwise close the string it sits in and append rules of its own.
 */
export function confine(command: string, args: string[], options: ConfineOptions): Confinement {
  // Held to SANDBOX_COMMAND's rule, confined or not (BP-733)
  if (!isAbsolute(command)) {
    return { refusal: `refusing to run ${JSON.stringify(command)} by name on PATH: confine needs its absolute path` };
  }
  if (unconfinedAgentAllowed(options.env)) return { command, args };

  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return { refusal: UNCONFINED_REASON };

  if (options.writable.length === 0) {
    return { refusal: "refusing to confine an agent with no writable path: it could not even edit the worktree" };
  }

  const lstat = options.lstat ?? lstatSync;
  const resolved: string[] = [];
  for (const entry of options.writable) {
    if (typeof entry !== "string") {
      const replaced = dirReplaced(entry, lstat);
      if (replaced) {
        return { refusal: `refusing to confine the agent to ${entry.path}: ${replaced} since it was created`, replaced };
      }
      resolved.push(entry.path);
      continue;
    }
    try {
      // Seatbelt matches the resolved path, so an unresolved `/tmp/x` installs a rule for a
      // directory the kernel never sees — a profile that reads correctly and permits nothing.
      resolved.push(recordDir(entry, options.realpath ?? realpathSync, lstat).path);
    } catch (error) {
      return { refusal: `cannot confine the agent to ${entry}: ${String(error)}` };
    }
  }

  const names = resolved.map((_, index) => `W${index}`);
  return {
    command: SANDBOX_COMMAND,
    args: [
      "-p",
      [profileFor(names), ...(options.network === "loopback" ? LOOPBACK_ONLY : [])].join("\n"),
      ...names.flatMap((name, index) => ["-D", `${name}=${resolved[index]}`]),
      command,
      ...args,
    ],
  };
}

export function confineTool(
  tool: ResolvedTool,
  path: string,
  args: string[],
  options: ConfineOptions
): Confinement {
  if (!isAbsolute(path)) return { refusal: unresolvedToolReason(tool) };
  return confine(path, args, options);
}
