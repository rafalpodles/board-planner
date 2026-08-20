import { describe, it, expect, vi } from "vitest";
import { CommandResult, Runner } from "./exec.js";
import { checkRepo, pathWithTools, runPreflight } from "./preflight.js";

const LOGGED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "someone@example.com",
  subscriptionType: "max",
});

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const fail = (stderr = ""): CommandResult => ({ code: 1, stdout: "", stderr, timedOut: false });

// Resolution goes through a login shell, so every stub keys on what that shell was asked to run
interface Machine {
  has?: string[];
  claudeAuth?: CommandResult;
  ghAuth?: CommandResult;
  // `gh auth token --user <login>` — the authoritative answer to "does gh hold this account", and
  // a different call from `gh auth status`
  ghToken?: CommandResult;
  versions?: Record<string, CommandResult>;
  shellNoise?: string;
  // Present on disk but not on the login shell's PATH — ~/.local/bin, which .zshrc adds and a
  // login shell never reads
  onDiskOnly?: Record<string, string>;
  // What PATH each verification actually ran with, keyed by the binary
  ranWith?: Record<string, string | undefined>;
}

const NODE = "/Users/someone/.nvm/versions/node/v22.22.1/bin/node";

function machine(spec: Machine = {}): {
  runner: Runner;
  calls: string[][];
  ranWith: Record<string, string | undefined>;
  envs: Record<string, NodeJS.ProcessEnv | undefined>;
  isExecutable: (path: string) => boolean;
} {
  const has = spec.has ?? ["git", "npm", "claude", "gh"];
  const onDisk = spec.onDiskOnly ?? {};
  const calls: string[][] = [];
  const ranWith: Record<string, string | undefined> = {};
  const envs: Record<string, NodeJS.ProcessEnv | undefined> = {};

  const runner: Runner = {
    run: vi.fn(async (command: string, args: string[], opts) => {
      calls.push([command, ...args]);

      const lookup = /^command -v (\S+)$/.exec(args[args.length - 1] ?? "");
      if (lookup) {
        const tool = lookup[1];
        if (!has.includes(tool)) return fail();
        return ok(`${spec.shellNoise ?? ""}/opt/homebrew/bin/${tool}\n`);
      }

      const tool = command.split("/").pop() ?? command;
      ranWith[tool] = opts.env?.PATH;
      envs[tool] = opts.env;

      if (command.endsWith("/claude") && args[0] === "auth") return spec.claudeAuth ?? ok(LOGGED_IN);
      if (command.endsWith("/gh") && args[0] === "auth" && args[1] === "token") {
        return spec.ghToken ?? ok("gho_a_token\n");
      }
      if (command.endsWith("/gh") && args[0] === "auth") {
        return spec.ghAuth ?? ok("Logged in to github.com account someone");
      }
      return spec.versions?.[tool] ?? ok(`${tool} 1.0.0`);
    }),
  };

  return {
    runner,
    calls,
    ranWith,
    envs,
    isExecutable: (path: string) => Object.values(onDisk).includes(path),
  };
}

const env = { SHELL: "/bin/zsh", HOME: "/Users/someone", PATH: "/usr/bin:/bin" };

function depsFor(
  m: ReturnType<typeof machine>,
  override: Partial<{ env: typeof env; pinnedGithubAccount: string }> = {}
) {
  return {
    runner: m.runner,
    env: override.env ?? env,
    execPath: NODE,
    isExecutable: m.isExecutable,
    pinnedGithubAccount: override.pinnedGithubAccount,
  };
}

const TWO_GH_ACCOUNTS = `github.com
  ✓ Logged in to github.com account podlesrafal (keyring)
  - Active account: true
  - Git operations protocol: ssh

  ✓ Logged in to github.com account rafalpodles (keyring)
  - Active account: false
  - Git operations protocol: ssh
`;

function check(report: { checks: { name: string; ok: boolean; detail: string }[] }, name: string) {
  const found = report.checks.find((c) => c.name === name);
  if (!found) throw new Error(`no check named ${name} in ${report.checks.map((c) => c.name).join(", ")}`);
  return found;
}

describe("runPreflight", () => {
  it("passes on a machine that has everything, and names the claude account", async () => {
    const m = machine();

    const report = await runPreflight(depsFor(m));

    expect(report.ok).toBe(true);
    expect(report.account).toBe("someone@example.com");
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("probes the tools without handing them the worker's own credentials", async () => {
    const m = machine();
    const withSecrets = { ...env, CP_API_TOKEN: "cp_operator_credential" } as typeof env;

    await runPreflight(depsFor(m, { env: withSecrets }));

    expect(m.envs.claude?.CP_API_TOKEN).toBeUndefined();
    expect(m.envs.gh?.CP_API_TOKEN).toBeUndefined();
    expect(m.envs.claude?.HOME).toBe("/Users/someone");
  });

  it("resolves absolute paths rather than only reporting that a tool exists", async () => {
    const m = machine();

    const report = await runPreflight(depsFor(m));

    expect(report.paths).toMatchObject({
      git: "/opt/homebrew/bin/git",
      npm: "/opt/homebrew/bin/npm",
      claude: "/opt/homebrew/bin/claude",
      gh: "/opt/homebrew/bin/gh",
    });
  });

  it("looks tools up through a login shell, since launchd's PATH has no Homebrew or nvm", async () => {
    const m = machine();

    await runPreflight(depsFor(m));

    expect(m.calls).toContainEqual(["/bin/zsh", "-lc", "command -v git"]);
  });

  it("ignores profile chatter a login shell prints before the path", async () => {
    const m = machine({ shellNoise: "Welcome to your shell!\nnvm: loaded\n" });

    const report = await runPreflight(depsFor(m));

    expect(report.paths.git).toBe("/opt/homebrew/bin/git");
  });

  it("fails, and says which one, when a binary is missing", async () => {
    const m = machine({ has: ["git", "npm", "claude"] });

    const report = await runPreflight(depsFor(m));

    expect(report.ok).toBe(false);
    expect(check(report, "gh").ok).toBe(false);
    expect(check(report, "gh").detail).toMatch(/not installed|could not be found/i);
    expect(check(report, "git").ok).toBe(true);
  });

  it("fails when a resolved binary will not run", async () => {
    const m = machine({ versions: { git: fail("bad interpreter") } });

    const report = await runPreflight(depsFor(m));

    expect(report.ok).toBe(false);
    expect(check(report, "git").ok).toBe(false);
  });

  it("fails when claude is installed but not logged in", async () => {
    const m = machine({ claudeAuth: ok(JSON.stringify({ loggedIn: false })) });

    const report = await runPreflight(depsFor(m));

    expect(report.ok).toBe(false);
    expect(check(report, "claude").ok).toBe(false);
    expect(check(report, "claude").detail).toMatch(/claude auth login/);
  });

  // An API key can do the work — it just bills per token instead of drawing on the subscription,
  // which is a thing to say out loud, not a thing to refuse
  it("passes but reports the billing when claude is authenticated with an API key", async () => {
    const m = machine({
      claudeAuth: ok(JSON.stringify({ loggedIn: true, authMethod: "apiKey", apiProvider: "firstParty" })),
    });

    const report = await runPreflight(depsFor(m));

    expect(report.ok).toBe(true);
    expect(check(report, "claude").ok).toBe(true);
    expect(check(report, "claude").detail).toMatch(/API key/i);
  });

  it("does not fail a worker whose claude is too old to answer auth status", async () => {
    const m = machine({ claudeAuth: fail("unknown command: auth") });

    const report = await runPreflight(depsFor(m));

    expect(check(report, "claude").ok).toBe(true);
    expect(check(report, "claude").detail).toMatch(/could not/i);
  });

  it("fails when gh is installed but not authenticated", async () => {
    const m = machine({ ghAuth: fail("You are not logged into any GitHub hosts") });

    const report = await runPreflight(depsFor(m));

    expect(report.ok).toBe(false);
    expect(check(report, "gh").ok).toBe(false);
    expect(check(report, "gh").detail).toMatch(/gh auth login/);
  });

  // BP-373. The check said `authenticated (/opt/homebrew/bin/gh)` while gh's active account was one
  // with no write access to the repository, so the panel was green and the clone step failed with
  // GitHub's own 403 two steps later. The identity that pushes is worth as much as the identity
  // that writes the code, and the claude check has always named that one.
  it("names the github account it is authenticated as", async () => {
    const m = machine({ ghAuth: ok(TWO_GH_ACCOUNTS) });

    const report = await runPreflight(depsFor(m));

    expect(check(report, "gh").ok).toBe(true);
    expect(check(report, "gh").detail).toContain("podlesrafal");
    expect(report.githubAccount).toBe("podlesrafal");
    expect(report.githubPinned).toBe(false);
  });

  it("lists every account gh knows, so the app can offer them without parsing this itself", async () => {
    const m = machine({ ghAuth: ok(TWO_GH_ACCOUNTS) });

    const report = await runPreflight(depsFor(m));

    expect(report.githubAccounts).toEqual([
      { login: "podlesrafal", active: true },
      { login: "rafalpodles", active: false },
    ]);
  });

  it("says a machine with several accounts uses whichever is active until one is pinned", async () => {
    const m = machine({ ghAuth: ok(TWO_GH_ACCOUNTS) });

    const report = await runPreflight(depsFor(m));

    expect(check(report, "gh").detail).toMatch(/pin/i);
  });

  it("reports the pinned account rather than gh's active one", async () => {
    const m = machine({ ghAuth: ok(TWO_GH_ACCOUNTS) });

    const report = await runPreflight(depsFor(m, { pinnedGithubAccount: "rafalpodles" }));

    expect(check(report, "gh").ok).toBe(true);
    expect(report.githubAccount).toBe("rafalpodles");
    expect(report.githubPinned).toBe(true);
    // Both names, because the difference between them is the whole answer to "why is it pushing as
    // somebody else" — and it is invisible from either name alone
    expect(check(report, "gh").detail).toContain("rafalpodles");
    expect(check(report, "gh").detail).toContain("podlesrafal");
  });

  // Deciding a machine is broken on a text parse would turn any change to gh's status output into a
  // red row on a worker that is perfectly fine. `auth token --user` answers the actual question by
  // name, with an exit code, so the pin survives an output shape this parser has never seen.
  it("verifies the pin against gh itself, not against the status text it parsed", async () => {
    const m = machine({ ghAuth: ok("some future format nobody has parsed") });

    const report = await runPreflight(depsFor(m, { pinnedGithubAccount: "rafalpodles" }));

    expect(check(report, "gh").ok).toBe(true);
    expect(report.githubAccount).toBe("rafalpodles");
    expect(m.calls).toContainEqual([
      "/opt/homebrew/bin/gh",
      "auth",
      "token",
      "--user",
      "rafalpodles",
    ]);
  });

  // The token is the means, never the message: a preflight report travels to the server on the
  // heartbeat and is rendered in the fleet console.
  it("puts no token in the report it hands back", async () => {
    const m = machine({ ghAuth: ok(TWO_GH_ACCOUNTS), ghToken: ok("gho_a_real_looking_token") });

    const report = await runPreflight(depsFor(m, { pinnedGithubAccount: "rafalpodles" }));

    expect(JSON.stringify(report)).not.toContain("gho_");
  });

  // Refused here, where the fix is one click away, rather than at push time — which is 30 minutes
  // of agent work later, and reads as a repository permission problem.
  it("fails when the pinned account is one gh has no session for", async () => {
    const m = machine({ ghAuth: ok(TWO_GH_ACCOUNTS), ghToken: fail("no such user") });

    const report = await runPreflight(depsFor(m, { pinnedGithubAccount: "someone-else" }));

    expect(report.ok).toBe(false);
    expect(check(report, "gh").ok).toBe(false);
    expect(check(report, "gh").detail).toContain("someone-else");
    expect(check(report, "gh").detail).toMatch(/gh auth login/);
  });

  // Both found by running this against a real machine under a launchd-shaped PATH, and neither was
  // visible to the stubs before that.
  it("verifies each binary on the repaired PATH, not the one the worker was started with", async () => {
    // npm's shebang is `env node`, so asking it for its version on launchd's PATH reports a
    // perfectly good npm as broken
    const m = machine();

    await runPreflight(depsFor(m));

    expect(m.ranWith.npm).toContain("/Users/someone/.nvm/versions/node/v22.22.1/bin");
  });

  it("carries the worker's own node, since npm cannot start without it", async () => {
    const m = machine();

    const report = await runPreflight(depsFor(m));

    expect(report.paths.node).toBe(NODE);
  });

  // zsh reads .zprofile on login but .zshrc only when interactive, so a PATH entry added there —
  // ~/.local/bin, where claude installs itself — is invisible to `zsh -lc`
  it("finds a tool the login shell cannot see but which is on disk anyway", async () => {
    const m = machine({
      has: ["git", "npm", "gh"],
      onDiskOnly: { claude: "/Users/someone/.local/bin/claude" },
    });

    const report = await runPreflight(depsFor(m));

    expect(report.paths.claude).toBe("/Users/someone/.local/bin/claude");
    expect(check(report, "claude").ok).toBe(true);
  });

  it("still fails a tool that is neither on the shell's PATH nor anywhere conventional", async () => {
    const m = machine({ has: ["git", "npm", "claude"] });

    const report = await runPreflight(depsFor(m));

    expect(check(report, "gh").ok).toBe(false);
  });

  it("falls back to a shell that exists when the environment names none", async () => {
    const m = machine();

    await runPreflight(depsFor(m, { env: { PATH: "/usr/bin" } as typeof env }));

    expect(m.calls[0][0]).toBe("/bin/sh");
  });
});

describe("pathWithTools", () => {
  it("prepends the directories the tools were actually found in", () => {
    const result = pathWithTools({ git: "/opt/homebrew/bin/git", claude: "/Users/me/.local/bin/claude" }, "/usr/bin:/bin");

    expect(result).toBe("/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin:/bin");
  });

  it("does not duplicate a directory the PATH already has", () => {
    const result = pathWithTools({ git: "/usr/bin/git" }, "/usr/bin:/bin");

    expect(result).toBe("/usr/bin:/bin");
  });

  it("lists each directory once even when several tools share it", () => {
    const result = pathWithTools(
      { git: "/opt/homebrew/bin/git", npm: "/opt/homebrew/bin/npm" },
      "/usr/bin"
    );

    expect(result).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("ignores tools that were never resolved", () => {
    const result = pathWithTools({ git: "" }, "/usr/bin");

    expect(result).toBe("/usr/bin");
  });
});

describe("checkRepo", () => {
  const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });

  it("passes a repository with a lockfile and both scripts", () => {
    const checks = checkRepo(
      (path) => (path.endsWith("package-lock.json") ? "{}" : pkg({ build: "next build", test: "vitest run" })),
      "/repo"
    );

    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("fails without a lockfile, because the build gate runs npm ci unconditionally", () => {
    const checks = checkRepo(
      (path) => (path.endsWith("package-lock.json") ? null : pkg({ build: "x", test: "y" })),
      "/repo"
    );

    const lock = checks.find((c) => c.name.includes("package-lock"));
    expect(lock?.ok).toBe(false);
    expect(lock?.detail).toMatch(/npm ci/);
  });

  it("fails a repository with no build or test script", () => {
    const checks = checkRepo((path) => (path.endsWith("package-lock.json") ? "{}" : pkg({})), "/repo");

    expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["build script", "test script"]);
  });

  it("does not throw on a package.json that is not valid JSON", () => {
    const checks = checkRepo((path) => (path.endsWith("package-lock.json") ? "{}" : "not json {"), "/repo");

    expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["build script", "test script"]);
  });

  it("names the repository in the failure, since a worker can serve several", () => {
    const checks = checkRepo(() => null, "/Users/me/checkouts/thing");

    expect(checks.every((c) => c.detail.includes("/Users/me/checkouts/thing"))).toBe(true);
  });
});
