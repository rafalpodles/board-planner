import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, sep } from "path";
import { childEnv } from "./env.js";
import { Runner } from "./exec.js";

// A repository path is a capability grant, not configuration: a .git/config the operator didn't
// write can make `git status` alone run an attacker's command via core.fsmonitor, core.pager,
// diff.external, core.sshCommand or filter.*. Every rule below runs in this exact order and
// refuses at the first failure, cheapest checks first, nothing touching git until the rest pass.

export interface RepoDeps {
  runner: Runner;
  readAllowlist: () => string;
  realpath: (p: string) => string;
  stat: (p: string) => { uid: number; mode: number };
  uid: number;
  workerId?: string;
}

type BindResult = { ok: true; path: string; worktreeRoot: string } | { ok: false; reason: string };

const GIT_TIMEOUT_MS = 60_000;

// macOS canonicalises /etc, /tmp and /var to /private/*, so both forms of each are listed —
// otherwise a proposedPath spelled with the canonical form would slip past the alias.
const SENSITIVE_ROOTS = [
  join(homedir(), "Library"),
  join(homedir(), ".ssh"),
  join(homedir(), ".config"),
  join(homedir(), ".claude"),
  "/etc",
  "/private/etc",
  "/System",
  "/private/var",
  "/tmp",
  "/private/tmp",
];

// This denylist is defence in depth against a repository that was ALREADY hostile when it was
// proposed. It is not, and cannot be, a complete boundary, for two reasons that no amount of
// enumeration fixes: the worker's agent runs with git in its own tool allowlist, so once a
// repository is bound it can set any config key it likes inside that worktree — this scan runs
// once, at bind time, against config the agent has not touched yet. And GIT_CONFIG_NOSYSTEM plus
// the -c overrides neutralise system and command-line config on every call, but nothing disables
// repository-local config, because filter/diff/merge drivers and credential helpers need it to
// work at all. Keep the list honest, not exhaustive: match only the subkeys git actually executes,
// so a legitimate Git-LFS or gitattributes repository is not refused for an inert sibling key.
const EXACT_DANGEROUS_KEYS = [
  "core.fsmonitor",
  "core.pager",
  "core.sshcommand",
  "core.hookspath",
  "core.editor",
  "sequence.editor",
  "diff.external",
];

// <family>.<name>.<leaf> keys whose value git runs as a command. Everything else under these
// sections (filter.*.required, diff.*.binary/xfuncname/algorithm, merge.*.name, ...) is inert and
// must be allowed.
const EXECUTABLE_LEAVES: Record<string, string[]> = {
  "filter.": ["clean", "smudge", "process"],
  "diff.": ["textconv", "command"],
  "merge.": ["driver"],
  "credential.": ["helper"],
};

function sensitiveLocation(path: string): string | null {
  const root = SENSITIVE_ROOTS.find((dir) => path === dir || path.startsWith(`${dir}${sep}`));
  if (root) return `${path} is under the sensitive directory ${root}`;
  if (path.split(sep).includes("node_modules")) return `${path} contains a node_modules segment`;
  return null;
}

function dangerousFamilyLeaf(key: string): boolean {
  for (const [family, leaves] of Object.entries(EXECUTABLE_LEAVES)) {
    if (!key.startsWith(family)) continue;
    const rest = key.slice(family.length);
    const leaf = rest.slice(rest.lastIndexOf(".") + 1);
    if (leaves.includes(leaf)) return true;
  }
  return false;
}

// protocol.<name>.allow (or the bare protocol.allow default) does not itself hold a command, but
// paired with a remote.*.url using the ext:: transport it makes git run one — ext defaults to
// "never" precisely because it executes a program, and local config can override that default.
function isProtocolAllowKey(key: string): boolean {
  return key === "protocol.allow" || (key.startsWith("protocol.") && key.endsWith(".allow"));
}

function usesExtTransport(value: string): boolean {
  return value.trim().toLowerCase().startsWith("ext::");
}

function dangerousConfigEntry(listOutput: string): string | null {
  for (const rawLine of listOutput.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    const key = (eq === -1 ? line : line.slice(0, eq)).toLowerCase();
    const value = eq === -1 ? "" : line.slice(eq + 1);

    if (EXACT_DANGEROUS_KEYS.includes(key)) return key;
    if (key.startsWith("alias.")) return key;
    if (dangerousFamilyLeaf(key)) return key;
    if (isProtocolAllowKey(key)) return key;
    if (usesExtTransport(value)) return key;
  }
  return null;
}

// Neutralises a hostile system or repository gitconfig on every call this module makes, the same
// way GIT_CONFIG_NOSYSTEM does for the environment.
function git(runner: Runner, cwd: string, args: string[]) {
  return runner.run("git", ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", ...args], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    env: { ...childEnv(), GIT_CONFIG_NOSYSTEM: "1" },
  });
}

export async function bindRepository(deps: RepoDeps, proposedPath: string): Promise<BindResult> {
  if (!isAbsolute(proposedPath) || proposedPath.split(sep).includes("..")) {
    return { ok: false, reason: `${proposedPath} must be an absolute path free of ".."` };
  }

  let allowlist: string[];
  try {
    allowlist = (JSON.parse(deps.readAllowlist()).repos ?? []) as string[];
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  if (!allowlist.includes(proposedPath)) {
    return { ok: false, reason: `${proposedPath} is not approved on this machine — add it to repos.json` };
  }

  let resolved: string;
  try {
    resolved = deps.realpath(proposedPath);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  if (resolved !== proposedPath) {
    return { ok: false, reason: `${proposedPath} resolves to ${resolved} — allowlist entries may not be symlinks` };
  }

  const sensitive = sensitiveLocation(proposedPath);
  if (sensitive) {
    return { ok: false, reason: sensitive };
  }

  let info: { uid: number; mode: number };
  try {
    info = deps.stat(proposedPath);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  if (info.uid !== deps.uid) {
    return { ok: false, reason: `${proposedPath} is not owned by this worker` };
  }
  if (info.mode & 0o022) {
    return { ok: false, reason: `${proposedPath} is group- or world-writable` };
  }

  const toplevel = await git(deps.runner, proposedPath, ["rev-parse", "--show-toplevel"]);
  if (toplevel.code !== 0 || toplevel.timedOut) {
    return { ok: false, reason: `${proposedPath} is not a git repository` };
  }
  if (toplevel.stdout.trim() !== proposedPath) {
    return { ok: false, reason: `${proposedPath} is not its own git toplevel` };
  }

  const config = await git(deps.runner, proposedPath, ["config", "--local", "--list"]);
  if (config.code !== 0 || config.timedOut) {
    return { ok: false, reason: `could not read git config in ${proposedPath}` };
  }
  const dangerous = dangerousConfigEntry(config.stdout);
  if (dangerous) {
    return {
      ok: false,
      reason: `${proposedPath}'s git config sets ${dangerous}, which can make git run an attacker's command`,
    };
  }

  const worktreeRoot = join(dirname(proposedPath), "cp-worktrees", deps.workerId ?? String(deps.uid));
  return { ok: true, path: proposedPath, worktreeRoot };
}

// Mirrors config.ts's readSecretFile discipline: repos.json decides what code can run on this
// machine, so a copy readable by group or others is refused, the same as a loose SSH key.
export function createAllowlistReader(stateDir: string): () => string {
  const path = join(stateDir, "repos.json");
  return () => {
    const { mode } = statSync(path);
    if (mode & 0o077) {
      throw new Error(
        `${path} is readable by group or others (mode ${(mode & 0o777).toString(8)}); run chmod 600 on it`
      );
    }
    return readFileSync(path, "utf8");
  };
}
