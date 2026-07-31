import { join, sep } from "path";
import { WorkerConfig } from "./config.js";
import { Runner } from "./exec.js";

const GIT_TIMEOUT_MS = 60_000;

export interface Workspace {
  create(taskKey: string, slug: string): Promise<string>;
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

export function createWorkspace(config: WorkerConfig, runner: Runner): Workspace {
  const pathFor = (taskKey: string) => join(config.worktreeRoot, taskKey);

  async function git(args: string[]): Promise<string> {
    const result = await runner.run("git", args, {
      cwd: config.repoPath,
      timeoutMs: GIT_TIMEOUT_MS,
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

  return {
    async create(taskKey, slug) {
      const path = pathFor(taskKey);
      const branch = `${taskKey.toLowerCase()}/${slug}`;

      await removeIfRegistered(path);
      // -B resets the branch instead of failing if a crashed previous attempt already created it
      await git(["worktree", "add", "-B", branch, path]);
      return path;
    },

    async destroy(taskKey) {
      await removeIfRegistered(pathFor(taskKey));
    },

    listWorktrees() {
      return registeredWorktreePaths();
    },
  };
}
