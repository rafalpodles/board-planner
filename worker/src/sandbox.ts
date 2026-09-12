import { realpathSync } from "fs";
import { UNCONFINED_ESCAPE_HATCH, unconfinedAgentAllowed } from "./env.js";

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
 * What this does not reach — writes a *daemon* performs on the process's behalf. `(allow default)`
 * leaves `process-exec` and `mach-lookup` open, and measured under this exact profile,
 * `defaults write <domain> <key> <value>` returns 0 and cfprefsd writes the plist under
 * `~/Library/Preferences`, outside the worktree. It is not reachable by the agent this worker runs
 * — `--tools` gives it no shell, so it spawns nothing — which means that particular gap is closed
 * by the tool allowlist in executor.ts and not by the kernel. A capability that ever yields process
 * execution has to close it here instead.
 *
 * What this does not reach: the gates. `npm ci`, `npm run build` and `npm test` run agent-written
 * code in the worktree and are not inside this profile, so a test the agent wrote can still write
 * where the agent itself now cannot (BP-608). This closes the agent's own tools, which is the move
 * that needed no gate and left no trace.
 *
 * Measured the same day: the CLI needs no write access to `~/.claude` or `~/.claude.json` at all.
 * `claude -p` under the profile below exits 0 with empty stderr and no permission denials, which is
 * what lets the allowance stay a list of directories rather than a denylist of the instruction
 * channels inside the operator's home.
 */

// Absolute, not `sandbox-exec` on the PATH. The worker extends its own PATH with directories
// preflight resolved, and a wrapper whose job is to constrain a hostile process must not be
// findable at a name: anything earlier on that PATH would silently become the sandbox. macOS keeps
// it here; a machine where it is not gets a refusal from preflight rather than a green row.
export const SANDBOX_COMMAND = "/usr/bin/sandbox-exec";

// The operator's own risk acceptance lives in env.ts, which owns reading this process's
// environment. It means the same thing on every platform — run the agent unconfined — so there is
// one sentence to read rather than a matrix.
export const UNCONFINED_REASON =
  "this machine has no sandbox the worker knows how to confine an agent with (seatbelt is macOS only), " +
  `so the agent could write anywhere this user can — set ${UNCONFINED_ESCAPE_HATCH}=1 to accept that and run anyway`;

export type Confinement =
  | { command: string; args: string[]; confined: boolean }
  | { refusal: string };

export interface ConfineOptions {
  /** Absolute paths the child may write to. Everything else is denied, including `$HOME`. */
  writable: string[];
  platform?: NodeJS.Platform;
  realpath?: (path: string) => string;
  env?: NodeJS.ProcessEnv;
}

// The order is the conventional one and not load-bearing here: measured on macOS 26.6.2, this
// profile denies the outside write with `(allow default)` moved last AND with the deny placed after
// the allow-back, so seatbelt on this system resolves by specificity rather than by last-match. It
// is kept in this order because that is also correct under last-match semantics, which is what SBPL
// has historically documented. What IS load-bearing is that the deny exists at all: the same
// profile without it lets the outside write through, measured in the same run.
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
  ].join("\n");
}

/**
 * Wraps a spawn so it can only write under `writable`, or says why it cannot.
 *
 * Paths travel as `-D` parameters rather than as text inside the profile: a directory name
 * containing a quote would otherwise close the string it sits in and append rules of its own.
 */
export function confine(command: string, args: string[], options: ConfineOptions): Confinement {
  if (unconfinedAgentAllowed(options.env)) return { command, args, confined: false };

  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return { refusal: UNCONFINED_REASON };

  if (options.writable.length === 0) {
    return { refusal: "refusing to confine an agent with no writable path: it could not even edit the worktree" };
  }

  const resolve = options.realpath ?? realpathSync;
  const resolved: string[] = [];
  for (const path of options.writable) {
    try {
      // Seatbelt matches the resolved path, so an unresolved `/tmp/x` installs a rule for a
      // directory the kernel never sees — a profile that reads correctly and permits nothing.
      resolved.push(resolve(path));
    } catch (error) {
      return { refusal: `cannot confine the agent to ${path}: ${String(error)}` };
    }
  }

  const names = resolved.map((_, index) => `W${index}`);
  return {
    confined: true,
    command: SANDBOX_COMMAND,
    args: [
      "-p",
      profileFor(names),
      ...names.flatMap((name, index) => ["-D", `${name}=${resolved[index]}`]),
      command,
      ...args,
    ],
  };
}
