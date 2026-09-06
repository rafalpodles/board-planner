import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve, sep } from "path";
import { childEnv } from "./env.js";
import { RepoInventory } from "./config.js";
import { Runner } from "./exec.js";
import { gitArgs, GIT_SAFE_ENV } from "./git-safety.js";

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

const CONFIG_LIST_ARGS = ["config", "--list", "--show-scope", "--no-includes"];

const REPO_SCOPES = ["local", "worktree"];

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

export async function configBaseline(
  runner: Runner,
  cwd: string,
): Promise<string[] | null> {
  const result = await git(runner, cwd, CONFIG_LIST_ARGS);
  if (result.code !== 0 || result.timedOut) return null;
  return parseConfigList(result.stdout).map((entry) => entry.raw);
}

export async function plantedConfig(
  runner: Runner,
  cwd: string,
  baseline?: readonly string[] | null,
): Promise<string> {
  const readable = await git(runner, cwd, ["config", "--local", "--list"]);
  if (readable.code !== 0 || readable.timedOut)
    return "an unreadable git config";

  const result = await git(runner, cwd, CONFIG_LIST_ARGS);
  if (result.code !== 0 || result.timedOut) return "an unreadable git config";

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
  const dangerous = dangerousConfigEntry(config.stdout);
  if (dangerous) {
    return {
      ok: false,
      reason: `${proposedPath}'s git config sets ${dangerous}, which can make git run an attacker's command`,
    };
  }

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
