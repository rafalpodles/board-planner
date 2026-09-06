import { dirname, join } from "path";
import { childEnv } from "./env.js";
import { Runner } from "./exec.js";
import { GhAccount, parseGhAccounts, resolveGhToken, usableAccount } from "./github-account.js";

export const TOOLS = ["git", "npm", "claude", "gh"] as const;
export type ToolName = (typeof TOOLS)[number];

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PreflightReport {
  ok: boolean;
  account: string;
  checks: PreflightCheck[];
  paths: Record<string, string>;
  githubAccounts: GhAccount[];
  githubAccount: string;
  githubPinned: boolean;
}

export interface PreflightDeps {
  runner: Runner;
  env: Record<string, string | undefined>;
  execPath: string;
  isExecutable: (path: string) => boolean;
  pinnedGithubAccount?: string;
}

const TIMEOUT_MS = 20_000;

const CONVENTIONAL_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

async function resolve(deps: PreflightDeps, tool: ToolName): Promise<string> {
  const shell = deps.env.SHELL?.trim() || "/bin/sh";
  const result = await deps.runner.run(shell, ["-lc", `command -v ${tool}`], {
    cwd: deps.env.HOME?.trim() || "/",
    timeoutMs: TIMEOUT_MS,
  });

  if (result.code === 0) {
    const last = result.stdout.trim().split("\n").pop()?.trim() ?? "";
    if (last.startsWith("/")) return last;
  }

  const home = deps.env.HOME?.trim();
  const candidates = [...(home ? [join(home, ".local/bin")] : []), ...CONVENTIONAL_DIRS];
  for (const dir of candidates) {
    const candidate = join(dir, tool);
    if (deps.isExecutable(candidate)) return candidate;
  }
  return "";
}

function missing(tool: ToolName): PreflightCheck {
  return {
    name: tool,
    ok: false,
    detail: `${tool} could not be found on this machine, and every task needs it`,
  };
}

async function runs(
  deps: PreflightDeps,
  tool: ToolName,
  path: string,
  env: NodeJS.ProcessEnv
): Promise<PreflightCheck | null> {
  const result = await deps.runner.run(path, ["--version"], {
    cwd: deps.env.HOME?.trim() || "/",
    timeoutMs: TIMEOUT_MS,
    env,
  });
  if (result.code === 0) return null;
  return {
    name: tool,
    ok: false,
    detail: `${path} is present but will not run: ${(result.stderr || result.stdout).trim().split("\n")[0]}`,
  };
}

interface ClaudeAuth {
  loggedIn?: unknown;
  authMethod?: unknown;
  email?: unknown;
  subscriptionType?: unknown;
}

async function claudeSession(
  deps: PreflightDeps,
  path: string,
  env: NodeJS.ProcessEnv
): Promise<{ check: PreflightCheck; account: string }> {
  const result = await deps.runner.run(path, ["auth", "status", "--json"], {
    cwd: deps.env.HOME?.trim() || "/",
    timeoutMs: TIMEOUT_MS,
    env,
  });

  let parsed: ClaudeAuth | null = null;
  if (result.code === 0) {
    try {
      parsed = JSON.parse(result.stdout.trim()) as ClaudeAuth;
    } catch {
      parsed = null;
    }
  }

  if (!parsed || typeof parsed.loggedIn !== "boolean") {
    return {
      account: "",
      check: {
        name: "claude",
        ok: true,
        detail: "could not determine which account claude is signed into — the CLI is older than `auth status --json`",
      },
    };
  }

  if (!parsed.loggedIn) {
    return {
      account: "",
      check: {
        name: "claude",
        ok: false,
        detail: "claude is installed but not signed in — run `claude auth login`",
      },
    };
  }

  const account = typeof parsed.email === "string" ? parsed.email : "";
  const plan = typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : "";

  if (parsed.authMethod === "apiKey") {
    return {
      account,
      check: {
        name: "claude",
        ok: true,
        detail: `signed in with an API key${account ? ` (${account})` : ""} — every run bills per token rather than drawing on a subscription`,
      },
    };
  }

  return {
    account,
    check: {
      name: "claude",
      ok: true,
      detail: `signed in as ${account || "an unnamed account"}${plan ? ` on ${plan}` : ""}`,
    },
  };
}

async function ghSession(
  deps: PreflightDeps,
  path: string,
  env: NodeJS.ProcessEnv
): Promise<{ check: PreflightCheck; accounts: GhAccount[]; login: string; pinned: boolean }> {
  const result = await deps.runner.run(path, ["auth", "status"], {
    cwd: deps.env.HOME?.trim() || "/",
    timeoutMs: TIMEOUT_MS,
    env,
  });

  if (result.code !== 0) {
    return {
      check: {
        name: "gh",
        ok: false,
        detail:
          "gh is installed but not authenticated — run `gh auth login`; it pushes branches and opens pull requests as that identity",
      },
      accounts: [],
      login: "",
      pinned: false,
    };
  }

  const accounts = parseGhAccounts(`${result.stdout}\n${result.stderr}`);
  const usable = usableAccount(accounts, deps.pinnedGithubAccount ?? "");
  const report = (ok: boolean, detail: string): PreflightCheck => ({ name: "gh", ok, detail });

  const resolvable = usable.pinned
    ? !!(await resolveGhToken(deps.runner, path, usable.login, env, deps.env.HOME?.trim() || "/"))
    : false;

  if (usable.pinned && !resolvable) {
    return {
      check: report(
        false,
        `pinned to the GitHub account ${usable.login}, which gh cannot produce a token for — run \`gh auth login\` as ${usable.login}, or pick another account in the app`
      ),
      accounts,
      login: usable.login,
      pinned: true,
    };
  }

  if (usable.pinned) {
    const active = accounts.find((a) => a.active)?.login ?? "";
    const aside =
      active && active !== usable.login ? ` (gh's own active account is ${active})` : "";
    return {
      check: report(true, `pinned to ${usable.login}${aside}`),
      accounts,
      login: usable.login,
      pinned: true,
    };
  }

  if (!usable.login) {
    return {
      check: report(
        true,
        `authenticated (${path}), but gh did not say which account — pushes act as whichever it has active`
      ),
      accounts,
      login: "",
      pinned: false,
    };
  }

  const drift =
    accounts.length > 1
      ? ` — gh holds ${accounts.length} accounts and any terminal can switch them, so pin one in the app`
      : "";
  return {
    check: report(true, `signed in as ${usable.login}${drift}`),
    accounts,
    login: usable.login,
    pinned: false,
  };
}

export async function runPreflight(deps: PreflightDeps): Promise<PreflightReport> {
  const paths: Record<string, string> = { node: deps.execPath };
  for (const tool of TOOLS) {
    const path = await resolve(deps, tool);
    if (path) paths[tool] = path;
  }

  const env = {
    ...childEnv([], deps.env),
    PATH: pathWithTools(paths, deps.env.PATH ?? ""),
  };

  const checks: PreflightCheck[] = [];
  let account = "";
  let githubAccounts: GhAccount[] = [];
  let githubAccount = "";
  let githubPinned = false;

  for (const tool of TOOLS) {
    const path = paths[tool];
    if (!path) {
      checks.push(missing(tool));
      continue;
    }

    const broken = await runs(deps, tool, path, env);
    if (broken) {
      checks.push(broken);
      continue;
    }

    if (tool === "claude") {
      const session = await claudeSession(deps, path, env);
      account = session.account;
      checks.push(session.check);
    } else if (tool === "gh") {
      const session = await ghSession(deps, path, env);
      githubAccounts = session.accounts;
      githubAccount = session.login;
      githubPinned = session.pinned;
      checks.push(session.check);
    } else {
      checks.push({ name: tool, ok: true, detail: path });
    }
  }

  return {
    ok: checks.every((c) => c.ok),
    account,
    checks,
    paths,
    githubAccounts,
    githubAccount,
    githubPinned,
  };
}

export function pathWithTools(paths: Record<string, string>, currentPath: string): string {
  const existing = currentPath.split(":").filter(Boolean);
  const additions: string[] = [];

  for (const path of Object.values(paths)) {
    if (!path) continue;
    const dir = dirname(path);
    if (existing.includes(dir) || additions.includes(dir)) continue;
    additions.push(dir);
  }

  return [...additions, ...existing].join(":");
}

export function checkRepo(read: (path: string) => string | null, repoPath: string): PreflightCheck[] {
  const checks: PreflightCheck[] = [];

  const hasLock = read(join(repoPath, "package-lock.json")) !== null;
  checks.push({
    name: "package-lock.json",
    ok: hasLock,
    detail: hasLock
      ? `present in ${repoPath}`
      : `${repoPath} has no package-lock.json, and the build gate runs npm ci, which fails without one`,
  });

  let scripts: Record<string, unknown> = {};
  const manifest = read(join(repoPath, "package.json"));
  if (manifest !== null) {
    try {
      const parsed = JSON.parse(manifest) as { scripts?: Record<string, unknown> };
      scripts = parsed.scripts ?? {};
    } catch {
      scripts = {};
    }
  }

  for (const script of ["build", "test"] as const) {
    const value = scripts[script];
    const ok = typeof value === "string" && value.trim() !== "";
    checks.push({
      name: `${script} script`,
      ok,
      detail: ok
        ? `npm run ${script} is defined`
        : `${repoPath} has no ${script} script, and the ${script} gate runs on every task`,
    });
  }

  return checks;
}
