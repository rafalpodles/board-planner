import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve, sep } from "path";
import { childEnv } from "./env.js";
import { RepoInventory } from "./config.js";
import { Runner } from "./exec.js";
import { gitArgs, GIT_SAFE_ENV } from "./git-safety.js";

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
  workerId: string;
}

type BindResult =
  | { ok: true; path: string; worktreeRoot: string }
  | { ok: false; reason: string };

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

// The allowlist entry the operator picked, plus realpath below, is the actual security boundary —
// it is what stops a server (or whoever compromised it) from pointing the worker at a directory of
// its choosing. This denylist is a cheap, one-time defence in depth against a directory that was
// ALREADY hostile when the operator approved it; it is deliberately NOT exhaustive and cannot be
// made exhaustive by adding more keys. Two structural reasons bound it, not just missing entries:
// `git config --local --list` prints `include.path=<file>` but never that file's contents, so any
// key below can be smuggled through one level of indirection and this line scan will never see it
// — enumeration cannot close that gap, only the allowlist can. And once a repository is bound the
// agent holds `git` in its own tool allowlist, so it can set any config key it likes inside that
// worktree; this scan runs once, before the agent ever touches the checkout. Match only the
// subkeys git actually executes, so a legitimate Git-LFS or gitattributes repository is not refused
// for an inert sibling key — and do not chase completeness here; that game is already lost.
const EXACT_DANGEROUS_KEYS = [
  "core.fsmonitor",
  "core.pager",
  "core.sshcommand",
  "core.hookspath",
  "core.editor",
  "core.gitproxy",
  "sequence.editor",
  "diff.external",
];

// <family>.<name>.<leaf> keys whose value git runs as a command. Everything else under these
// sections (filter.*.required, diff.*.binary/xfuncname/algorithm, merge.*.name, ...) is inert and
// must be allowed. remote.*.receivepack/uploadpack fire on this module's own push/fetch.
const EXECUTABLE_LEAVES: Record<string, string[]> = {
  "filter.": ["clean", "smudge", "process"],
  "diff.": ["textconv", "command"],
  "merge.": ["driver"],
  "credential.": ["helper"],
  "remote.": ["receivepack", "uploadpack"],
};

function sensitiveLocation(path: string): string | null {
  const root = SENSITIVE_ROOTS.find(
    (dir) => path === dir || path.startsWith(`${dir}${sep}`),
  );
  if (root) return `${path} is under the sensitive directory ${root}`;
  if (path.split(sep).includes("node_modules"))
    return `${path} contains a node_modules segment`;
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
// "never" is the explicitly safe value and must not be refused; anything else (always, user, or an
// unrecognised value) is treated as permissive, since this module's own git calls are the
// user-initiated case "user" allows.
function isPermissiveProtocolAllow(key: string, value: string): boolean {
  const isAllowKey =
    key === "protocol.allow" ||
    (key.startsWith("protocol.") && key.endsWith(".allow"));
  return isAllowKey && value.trim().toLowerCase() !== "never";
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
    if (isPermissiveProtocolAllow(key, value)) return key;
    if (usesExtTransport(value)) return key;
  }
  return null;
}

function git(runner: Runner, cwd: string, args: string[]) {
  return runner.run("git", gitArgs(args), {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    env: { ...childEnv(), ...GIT_SAFE_ENV },
  });
}

// `--show-scope` because the answer depends on who could have written the entry, and
// `--no-includes` because following an include is worse than not following it: measured on git
// 2.50.1, `--list` defaults includes ON, the included value is labelled with the *including*
// file's scope, and the file's content can be replaced between the scan and the use —
//
//     scan sees:  credential.helper=echo benign
//     (the include file is rewritten)
//     git uses:   !sh -c '…'
//
// So the indirection is refused as itself below rather than read through. That also means nothing
// of the operator's own included configuration is ever parsed by this scan.
const CONFIG_LIST_ARGS = ["config", "--list", "--show-scope", "--no-includes"];

// The scopes the agent writes *inside the repository*, which this pipeline created for the run —
// anything executable there is the agent's by construction. `global`, `system` and the `unknown`
// scope git reports for command-line and environment values are the operator's machine, where a
// credential helper is ordinary: measured on a normally-configured Mac, the effective config
// carries five executable keys, every one of them legitimate and every one of them a match for
// the rules below. Judging those without a baseline refuses the machine, not the attacker.
const REPO_SCOPES = ["local", "worktree"];

// include.path and includeIf.* carry no program themselves; they carry the file that does.
const INDIRECTION_KEYS = ["include.path", "includeif."];

interface ConfigEntry {
  scope: string;
  key: string;
  value: string;
  raw: string;
}

function parseConfigList(output: string): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  for (const raw of output.split("\n")) {
    if (!raw.trim()) continue;
    const tab = raw.indexOf("\t");
    if (tab === -1) continue;
    const scope = raw.slice(0, tab);
    const rest = raw.slice(tab + 1);
    const eq = rest.indexOf("=");
    entries.push({
      scope,
      key: (eq === -1 ? rest : rest.slice(0, eq)).toLowerCase(),
      value: eq === -1 ? "" : rest.slice(eq + 1),
      raw,
    });
  }
  return entries;
}

function isIndirection(key: string): boolean {
  return INDIRECTION_KEYS.some(
    (prefix) => key === prefix || key.startsWith(prefix),
  );
}

function executes(key: string, value: string): boolean {
  if (EXACT_DANGEROUS_KEYS.includes(key)) return true;
  if (key.startsWith("alias.")) return true;
  if (dangerousFamilyLeaf(key)) return true;
  if (isPermissiveProtocolAllow(key, value)) return true;
  if (usesExtTransport(value)) return true;
  return false;
}

/**
 * Everything the effective config says before the agent has touched the checkout, as raw
 * `scope\tkey=value` lines. Held in this process and never written down: the agent runs as this
 * uid with no filesystem sandbox, so a baseline on disk is a baseline it can edit. Same reason
 * `Worktree.baseSha` is carried rather than re-read.
 *
 * `null` when git could not answer. That is not "clean" and not "everything is new" — it means the
 * scan falls back to judging the repository's own scopes, which it can always judge on their own.
 */
export async function configBaseline(
  runner: Runner,
  cwd: string,
): Promise<string[] | null> {
  const result = await git(runner, cwd, CONFIG_LIST_ARGS);
  if (result.code !== 0 || result.timedOut) return null;
  return parseConfigList(result.stdout).map((entry) => entry.raw);
}

/**
 * The key the agent planted, or "" if it planted none.
 *
 * Two rules, because two questions. Inside the repository — `local` and `worktree`, both of which
 * this pipeline created for this run — anything that executes is the agent's, and so is any
 * `include.path` pointing somewhere this cannot vouch for. Outside it, on the operator's own
 * machine, only what *appeared since* `baseline` counts: a `gh` credential helper in `~/.gitconfig`
 * is why the guard exists at all, not evidence against the run.
 *
 * Without a baseline the machine scopes are not judged. That is deliberate and it is still
 * strictly more than the local-only scan it replaces — it adds the worktree scope and the
 * indirection — but a caller that can pass one closes `~/.gitconfig` too (BP-346).
 */
/**
 * What `plantedConfig` answers when git would not tell it. Named because the two answers are owed
 * different treatment by a caller that acts on the finding: a key somebody planted repeats until a
 * human removes it, while a config that could not be read is as likely to be a checkout that has
 * just been moved, or a machine under load. Both refuse the run; only one of them says anything
 * about the repository (BP-504).
 */
export const UNREADABLE_CONFIG = "an unreadable git config";

export async function plantedConfig(
  runner: Runner,
  cwd: string,
  baseline?: readonly string[] | null,
): Promise<string> {
  // Two questions, two calls. `--local --list` fails outside a checkout and `--list` does not — it
  // answers with the machine's global config instead — so widening the scan would have turned
  // "this is not a repository" into "this repository is clean" without anything going red.
  // Measured: exit 128 became exit 0 (BP-346).
  const readable = await git(runner, cwd, ["config", "--local", "--list"]);
  if (readable.code !== 0 || readable.timedOut)
    return UNREADABLE_CONFIG;

  const result = await git(runner, cwd, CONFIG_LIST_ARGS);
  // Unreadable is not the same as clean: a config this cannot read is one it cannot clear either.
  if (result.code !== 0 || result.timedOut) return UNREADABLE_CONFIG;

  const entries = parseConfigList(result.stdout);
  const known = new Set(baseline ?? []);
  for (const entry of entries) {
    const insideTheRepo = REPO_SCOPES.includes(entry.scope);
    const appearedSince = baseline != null && !known.has(entry.raw);
    if (!insideTheRepo && !appearedSince) continue;

    if (isIndirection(entry.key)) {
      return `${entry.key} (${entry.scope}), which points at a file this cannot vouch for`;
    }
    if (executes(entry.key, entry.value)) {
      return `${entry.key} (${entry.scope})`;
    }
  }
  return "";
}

export async function bindRepository(
  deps: RepoDeps,
  proposedPath: string,
): Promise<BindResult> {
  if (!isAbsolute(proposedPath) || proposedPath.split(sep).includes("..")) {
    return {
      ok: false,
      reason: `${proposedPath} must be an absolute path free of ".."`,
    };
  }

  let allowlist: string[];
  try {
    allowlist = (JSON.parse(deps.readAllowlist()).repos ?? []) as string[];
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  if (!allowlist.includes(proposedPath)) {
    return {
      ok: false,
      reason: `${proposedPath} is not approved on this machine — add it to repos.json`,
    };
  }

  let resolved: string;
  try {
    resolved = deps.realpath(proposedPath);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  if (resolved !== proposedPath) {
    return {
      ok: false,
      reason: `${proposedPath} resolves to ${resolved} — allowlist entries may not be symlinks`,
    };
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

  const toplevel = await git(deps.runner, proposedPath, [
    "rev-parse",
    "--show-toplevel",
  ]);
  if (toplevel.code !== 0 || toplevel.timedOut) {
    return { ok: false, reason: `${proposedPath} is not a git repository` };
  }
  if (toplevel.stdout.trim() !== proposedPath) {
    return { ok: false, reason: `${proposedPath} is not its own git toplevel` };
  }

  const config = await git(deps.runner, proposedPath, [
    "config",
    "--local",
    "--list",
  ]);
  if (config.code !== 0 || config.timedOut) {
    return {
      ok: false,
      reason: `could not read git config in ${proposedPath}`,
    };
  }
  // Narrower than the scan `workspace.create` makes: `--local --list` cannot see the worktree
  // scope and this rule does not judge `include.path`, so a checkout carrying either binds here
  // and is refused at run time instead — where, since BP-504, it quarantines the project. Aligning
  // the two is its own ticket: it would refuse checkouts that bind today, so it needs its own
  // sweep rather than a corner of this one.
  const dangerous = dangerousConfigEntry(config.stdout);
  if (dangerous) {
    return {
      ok: false,
      reason: `${proposedPath}'s git config sets ${dangerous}, which can make git run an attacker's command`,
    };
  }

  // registration.ts refuses a workerId that is not an ObjectId; this is the sink that would suffer
  // if anything ever got past it, and the only place that can still tell. `join` normalises "..",
  // so containment has to be judged after the path is built rather than on the segment before it.
  const container = join(dirname(proposedPath), "cp-worktrees");
  const worktreeRoot = resolve(container, deps.workerId);
  if (!worktreeRoot.startsWith(`${container}${sep}`)) {
    return {
      ok: false,
      reason: `worker id ${JSON.stringify(deps.workerId)} puts the worktree root at ${worktreeRoot}, outside ${container}`,
    };
  }
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
        `${path} is readable by group or others (mode ${(mode & 0o777).toString(8)}); run chmod 600 on it`,
      );
    }
    return readFileSync(path, "utf8");
  };
}

// What this machine offers, read from repos.json and resolved to each checkout's origin. Reported
// upward so the server can match a project by remote; the path travels only for display, and never
// comes back down.
//
// Returns a reason rather than an empty list when the file cannot be read. The two are not the
// same: an operator who emptied repos.json meant it, whereas a mode-644 file or a missing state
// directory is a fault — and reporting [] for a fault made the server wipe its stored inventory,
// leaving a worker that looked live, enabled and error-free while claiming nothing.
export type InventoryResult =
  { ok: true; repos: RepoInventory[] } | { ok: false; reason: string };

export async function repoInventory(
  deps: Pick<RepoDeps, "runner" | "readAllowlist">,
): Promise<InventoryResult> {
  let allowlist: unknown;
  try {
    allowlist = JSON.parse(deps.readAllowlist()).repos ?? [];
  } catch (error) {
    return {
      ok: false,
      reason: `could not read repos.json: ${(error as Error).message}`,
    };
  }
  if (!Array.isArray(allowlist)) {
    return {
      ok: false,
      reason: "repos.json: `repos` must be an array of absolute paths",
    };
  }

  const repos: RepoInventory[] = [];
  for (const path of allowlist) {
    if (typeof path !== "string" || !isAbsolute(path)) continue;
    // A directory that has gone away, or has no origin, is simply not offered — one bad entry must
    // not cost this machine every other checkout it could serve.
    const result = await git(deps.runner, path, [
      "remote",
      "get-url",
      "origin",
    ]).catch(() => null);
    const remote = result && result.code === 0 ? result.stdout.trim() : "";
    if (remote) repos.push({ remote, path });
  }
  return { ok: true, repos };
}
