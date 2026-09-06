import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import { WorkerConfig } from "./config.js";
import { childEnv } from "./env.js";
import { configBaseline, plantedConfig, UNREADABLE_CONFIG } from "./repos.js";
import { CommandResult, Runner } from "./exec.js";
import { gitArgs, GIT_SAFE_ENV } from "./git-safety.js";

const GIT_TIMEOUT_MS = 60_000;

export type BaseFaultKind = "transport" | "configuration";

export class BaseUnavailableError extends Error {
  readonly kind: BaseFaultKind;

  constructor(message: string, kind: BaseFaultKind = "transport") {
    super(message);
    this.name = "BaseUnavailableError";
    this.kind = kind;
  }
}

export class PoisonedCheckoutError extends Error {
  readonly finding: string;

  readonly kind: "planted" | "unreadable";

  constructor(finding: string) {
    super(
      finding === UNREADABLE_CONFIG
        ? "refusing to check out: the shared checkout's git config could not be read, so nothing can vouch for what a checkout would run"
        : `refusing to check out: ${JSON.stringify(finding)} is in the shared checkout's git config, and a checkout is where git runs one`
    );
    this.name = "PoisonedCheckoutError";
    this.finding = finding;
    this.kind = finding === UNREADABLE_CONFIG ? "unreadable" : "planted";
  }
}

export interface Worktree {
  path: string;
  baseSha: string;
  configBaseline: string[] | null;
}

export interface Workspace {
  create(taskKey: string, slug: string): Promise<Worktree>;
  destroy(taskKey: string): Promise<void>;
  listWorktrees(): Promise<string[]>;
}

export async function reapOrphans(workspace: Workspace, worktreeRoot: string): Promise<number> {
  const prefix = worktreeRoot.endsWith(sep) ? worktreeRoot : `${worktreeRoot}${sep}`;
  const orphans = (await workspace.listWorktrees().catch(() => []))
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length))
    .filter((taskKey) => taskKey.length > 0 && !taskKey.includes(sep));

  for (const taskKey of orphans) {
    await workspace.destroy(taskKey).catch(() => {});
  }
  return orphans.length;
}

export function createWorkspace(
  config: WorkerConfig,
  runner: Runner,
  remoteEnv?: () => NodeJS.ProcessEnv,
  remoteUrl?: string
): Workspace {
  function pathFor(taskKey: string): string {
    const root = resolve(config.worktreeRoot);
    const path = resolve(root, taskKey);
    if (!path.startsWith(`${root}${sep}`)) {
      throw new Error(
        `refusing task key ${JSON.stringify(taskKey)}: its path falls outside the worktree root ${root}`
      );
    }
    return path;
  }

  async function git(args: string[]): Promise<string> {
    const result = await runner.run("git", gitArgs(args), {
      cwd: config.repoPath,
      timeoutMs: GIT_TIMEOUT_MS,
      env: { ...childEnv(), ...GIT_SAFE_ENV, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    if (result.timedOut) {
      throw new Error(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS}ms`);
    }
    if (result.code !== 0) {
      throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout;
  }

  async function registeredWorktreePaths(): Promise<string[]> {
    const output = await git(["worktree", "list", "--porcelain"]);
    return output
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim());
  }

  async function removeIfRegistered(path: string): Promise<void> {
    if ((await registeredWorktreePaths()).includes(path)) {
      await git(["worktree", "remove", "--force", "--", path]);
    }
  }

  async function remoteRun(
    env: () => NodeJS.ProcessEnv,
    cwd: string,
    args: string[],
    extraEnv: NodeJS.ProcessEnv = {}
  ): Promise<CommandResult> {
    const result = await runner.run("git", args, {
      cwd,
      timeoutMs: GIT_TIMEOUT_MS,
      env: {
        ...childEnv([
          "SSH_AUTH_SOCK",
          "GH_TOKEN",
          "GITHUB_TOKEN",
          "GH_CONFIG_DIR",
          "XDG_CONFIG_HOME",
        ]),
        ...env(),
        ...GIT_SAFE_ENV,
        ...extraEnv,
      },
    });
    if (result.timedOut) {
      return { ...result, stderr: `git ${args[0]} timed out after ${GIT_TIMEOUT_MS}ms` };
    }
    return result;
  }

  function withNeutralGitHome<T>(run: (opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "bp-worker-base-"));
    return run({
      cwd: dir,
      env: { GIT_DIR: join(dir, "no-repository"), GIT_CEILING_DIRECTORIES: tmpdir() },
    }).finally(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
      }
    });
  }

  function shaForExactRef(lsRemoteStdout: string, ref: string): string {
    for (const line of lsRemoteStdout.split("\n")) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && sha) return sha;
    }
    return "";
  }

  async function resolveFreshBase(env: () => NodeJS.ProcessEnv, url: string): Promise<string> {
    const ref = `refs/heads/${config.baseBranch}`;
    const lsRemote = await withNeutralGitHome(({ cwd, env: neutralEnv }) =>
      remoteRun(env, cwd, ["ls-remote", "--", url, ref], neutralEnv)
    );
    if (lsRemote.code !== 0) {
      throw new BaseUnavailableError(
        `could not read ${ref} from ${url} (${lsRemote.stderr || lsRemote.stdout || "ls-remote failed"})`
      );
    }

    const remoteSha = shaForExactRef(lsRemote.stdout, ref);
    if (!remoteSha) {
      throw new BaseUnavailableError(`${url} did not report ${ref}`, "configuration");
    }

    const fetched = await remoteRun(env, config.repoPath, [
      "fetch",
      "--no-tags",
      "--",
      url,
      config.baseBranch,
    ]);
    if (fetched.code !== 0) {
      throw new BaseUnavailableError(
        `could not fetch ${config.baseBranch} from ${url} (${fetched.stderr || fetched.stdout || "fetch failed"})`
      );
    }

    try {
      return (await git(["rev-parse", "--verify", `${remoteSha}^{commit}`])).trim();
    } catch (error) {
      throw new BaseUnavailableError(
        `fetched ${config.baseBranch} from ${url} but ${remoteSha} did not resolve afterwards (${String(error)})`
      );
    }
  }

  async function resolveBase(): Promise<string> {
    if (!remoteEnv || !remoteUrl) {
      throw new BaseUnavailableError(
        `no remote is configured for this checkout, so ${config.baseBranch} could only be read from the local ref store, which a previous run's agent can write`,
        "configuration"
      );
    }
    return resolveFreshBase(remoteEnv, remoteUrl);
  }

  async function refuseIfPoisoned(): Promise<void> {
    const planted = await plantedConfig(runner, config.repoPath, undefined, {
      GIT_CONFIG_GLOBAL: "/dev/null",
    });
    if (planted) throw new PoisonedCheckoutError(planted);
  }

  return {
    async create(taskKey, slug) {
      const path = pathFor(taskKey);
      const branch = `${taskKey.toLowerCase()}/${slug}`;

      await refuseIfPoisoned();

      let baseSha: string;
      try {
        baseSha = await resolveBase();
      } catch (error) {
        throw new BaseUnavailableError(
          `could not resolve base branch ${config.baseBranch}: ${String(error)}`,
          error instanceof BaseUnavailableError ? error.kind : "transport"
        );
      }

      await removeIfRegistered(path);
      await refuseIfPoisoned();
      await git(["worktree", "add", "-B", branch, "--", path, baseSha]);
      return { path, baseSha, configBaseline: await configBaseline(runner, path) };
    },

    async destroy(taskKey) {
      await removeIfRegistered(pathFor(taskKey));
    },

    listWorktrees() {
      return registeredWorktreePaths();
    },
  };
}
