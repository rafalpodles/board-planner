import { dirname, join } from "path";
import { childEnv } from "./env.js";
import { Runner } from "./exec.js";

// The four binaries the worker shells out to. Nothing here is optional: without any one of them a
// task is claimed, run, and failed — three times, until the attempt cap routes it to a human.
export const TOOLS = ["git", "npm", "claude", "gh"] as const;
export type ToolName = (typeof TOOLS)[number];

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PreflightReport {
  ok: boolean;
  // Which account `claude` is signed into. The cost model depends on it being a subscription
  // session rather than an API key, and neither is visible without asking.
  account: string;
  checks: PreflightCheck[];
  // Absolute, so the PATH a spawned child gets can be repaired from them
  paths: Record<string, string>;
}

export interface PreflightDeps {
  runner: Runner;
  env: Record<string, string | undefined>;
  // The node this worker is itself running on. npm's shebang is `env node`, so a child whose PATH
  // cannot see node fails every `npm ci` with "env: node: No such file or directory" — and under
  // launchd, or under an app launched from Finder, an nvm node is exactly what PATH cannot see.
  execPath: string;
  isExecutable: (path: string) => boolean;
}

const TIMEOUT_MS = 20_000;

// A login shell reads .zprofile but not .zshrc, so anything the operator put on PATH in .zshrc —
// ~/.local/bin is the common one, and where `claude` installs itself — is invisible to it. Scanned
// only when the shell came back empty.
const CONVENTIONAL_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

// A worker started by launchd has PATH=/usr/bin:/bin:/usr/sbin:/sbin — no Homebrew, no nvm, no
// ~/.local/bin. A login shell is the only thing that knows where the operator actually installed
// these, so resolution has to go through one.
async function resolve(deps: PreflightDeps, tool: ToolName): Promise<string> {
  const shell = deps.env.SHELL?.trim() || "/bin/sh";
  const result = await deps.runner.run(shell, ["-lc", `command -v ${tool}`], {
    cwd: deps.env.HOME?.trim() || "/",
    timeoutMs: TIMEOUT_MS,
  });

  if (result.code === 0) {
    // A login shell prints whatever the operator's profile prints, so the path is the last line
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

// `claude auth status --json` arrived after the worker did, so an older CLI answers with a usage
// error. That is not a machine that cannot work — it is a machine we cannot ask, and saying so
// beats failing a worker whose session is fine.
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
): Promise<PreflightCheck> {
  const result = await deps.runner.run(path, ["auth", "status"], {
    cwd: deps.env.HOME?.trim() || "/",
    timeoutMs: TIMEOUT_MS,
    env,
  });
  if (result.code === 0) return { name: "gh", ok: true, detail: `authenticated (${path})` };
  return {
    name: "gh",
    ok: false,
    detail: "gh is installed but not authenticated — run `gh auth login`; it pushes branches and opens pull requests as that identity",
  };
}

export async function runPreflight(deps: PreflightDeps): Promise<PreflightReport> {
  // Resolve everything before verifying anything. Asking `npm --version` on the PATH this process
  // was started with is how a working npm reports itself broken: its shebang is `env node`, and the
  // node it needs is the one this worker is running on, which launchd's PATH has never heard of.
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
      checks.push(await ghSession(deps, path, env));
    } else {
      checks.push({ name: tool, ok: true, detail: path });
    }
  }

  return { ok: checks.every((c) => c.ok), account, checks, paths };
}

// The repair for the trap this whole check exists to close: resolving a binary through a login
// shell and then handing the child a PATH that cannot see it is preflight green, every task failing.
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

// `npm ci` and `npm run build` are unconditional in the gates, so a repository without a lockfile
// or without those scripts fails every task forever with nothing saying why. Checked per bound
// repository, because a worker can serve several.
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
