import { resolve, sep } from "path";
import { WorkerConfig } from "./config.js";
import { childEnv } from "./env.js";
import { CommandResult, Runner } from "./exec.js";
import { gitArgs, GIT_SAFE_ENV } from "./git-safety.js";

const GIT_TIMEOUT_MS = 60_000;

export interface Worktree {
  path: string;
  /** Resolved before the agent runs and held in this process: a ref name is rewritable by the run. */
  baseSha: string;
}

export interface Workspace {
  create(taskKey: string, slug: string): Promise<Worktree>;
  destroy(taskKey: string): Promise<void>;
  listWorktrees(): Promise<string[]>;
}

// A worktree under the worker's own root belongs to a run that died with its process. Nothing
// holds it, and leaving it there makes the next attempt on that task collide with its own branch
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
  remoteEnv?: () => NodeJS.ProcessEnv
): Workspace {
  // api.ts refuses a key that is not a name; this is the sink where a key becomes a path, and the
  // only place that can still tell a traversal from a directory name
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
      env: { ...childEnv(), ...GIT_SAFE_ENV },
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
      await git(["worktree", "remove", "--force", path]);
    }
  }

  async function runRemote(args: string[]): Promise<CommandResult> {
    return runner.run("git", gitArgs(args), {
      cwd: config.repoPath,
      timeoutMs: GIT_TIMEOUT_MS,
      env: { ...childEnv(["SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN"]), ...remoteEnv!() },
    });
  }

  // FETCH_HEAD, refs/remotes/origin/<branch> — whatever `git fetch` would normally leave behind
  // to say what it got — lives in the same shared, agent-writable ref store this branch stopped
  // trusting names in. Reading one back after the fetch would just trade a rewritable branch name
  // for a rewritable file next to it. ls-remote's answer is instead read straight off this
  // process's own stdout, in memory, before anything is written to disk; rev-parse is then asked
  // about that exact object id, a content-addressed lookup no planted ref can redirect.
  async function resolveFreshBase(): Promise<string | null> {
    const lsRemote = await runRemote(["ls-remote", "--exit-code", "origin", `refs/heads/${config.baseBranch}`]);
    const remoteSha = lsRemote.code === 0 ? lsRemote.stdout.trim().split(/\s+/)[0] : "";
    if (!remoteSha) {
      console.error(
        `could not read origin/${config.baseBranch} (${lsRemote.stderr || lsRemote.stdout || "ls-remote failed"}); using the local ref instead`
      );
      return null;
    }

    const fetched = await runRemote(["fetch", "--no-tags", "origin", config.baseBranch]);
    if (fetched.code !== 0) {
      console.error(
        `could not fetch origin/${config.baseBranch} (${fetched.stderr || fetched.stdout || "fetch failed"}); using the local ref instead`
      );
      return null;
    }

    try {
      return (await git(["rev-parse", "--verify", `${remoteSha}^{commit}`])).trim();
    } catch (error) {
      console.error(
        `fetched origin/${config.baseBranch} but ${remoteSha} did not resolve locally afterwards (${String(error)}); using the local ref instead`
      );
      return null;
    }
  }

  async function resolveBase(): Promise<string> {
    const fresh = remoteEnv ? await resolveFreshBase() : null;
    if (fresh) return fresh;
    return (await git(["rev-parse", "--verify", `${config.baseBranch}^{commit}`])).trim();
  }

  return {
    async create(taskKey, slug) {
      const path = pathFor(taskKey);
      const branch = `${taskKey.toLowerCase()}/${slug}`;
      let baseSha: string;
      try {
        baseSha = await resolveBase();
      } catch (error) {
        throw new Error(`could not resolve base branch ${config.baseBranch}: ${String(error)}`);
      }

      await removeIfRegistered(path);
      // -B resets the branch instead of failing if a crashed previous attempt already created it
      await git(["worktree", "add", "-B", branch, path, baseSha]);
      return { path, baseSha };
    },

    async destroy(taskKey) {
      await removeIfRegistered(pathFor(taskKey));
    },

    listWorktrees() {
      return registeredWorktreePaths();
    },
  };
}
