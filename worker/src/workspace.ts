import { tmpdir } from "os";
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
  remoteEnv?: () => NodeJS.ProcessEnv,
  remoteUrl?: string
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

  // The answer must not come from anything repoPath/.git can redirect, and passing `url` rather
  // than the remote name `origin` is not enough to achieve that: a repository-local
  // url.<x>.insteadOf rewrites every URL git sees, including one given literally in argv, and no
  // GIT_CONFIG_* variable turns that off — GIT_CONFIG_NOSYSTEM and GIT_CONFIG_GLOBAL drop the
  // system and global files only. Measured; the comment that used to stand here claimed the
  // opposite and the gate was reopened through it.
  //
  // Outside any repository there is no local config to honour. GIT_CEILING_DIRECTORIES stops
  // discovery from walking up out of the neutral directory and finding one anyway.
  //
  // No `-c` flags ride along: gitArgs()'s `-c credential.helper=` is the last thing git evaluates,
  // and for that multi-valued key it silently discards whatever env() installed — verified
  // empirically, and it made every https fetch fail to authenticate. hardenedGitConfig() already
  // covers hooksPath/fsmonitor/pager/protocol for this class of call, same as delivery's push.
  function remoteRun(
    env: () => NodeJS.ProcessEnv,
    cwd: string,
    args: string[],
    extraEnv: NodeJS.ProcessEnv = {}
  ): Promise<CommandResult> {
    return runner.run("git", args, {
      cwd,
      timeoutMs: GIT_TIMEOUT_MS,
      env: {
        ...childEnv(["SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN"]),
        ...env(),
        ...GIT_SAFE_ENV,
        ...extraEnv,
      },
    });
  }

  // ls-remote matches its pattern against the *tail* of a ref name at a `/` boundary, so asking
  // for refs/heads/main also returns refs/heads/aaa/refs/heads/main — which sorts first. Taking
  // the first line hands the base to anyone who can push a branch to the base repository, which
  // includes this worker. Only the exact ref counts.
  function shaForExactRef(lsRemoteStdout: string, ref: string): string {
    for (const line of lsRemoteStdout.split("\n")) {
      // ls-remote prints exactly `<oid> TAB <ref>`; the ref name is what has to match, and the
      // object id is verified as an object further down rather than by its spelling here.
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && sha) return sha;
    }
    return "";
  }

  // FETCH_HEAD, refs/remotes/origin/<branch> — whatever `git fetch` leaves behind to say what it
  // got — lives in the same shared, agent-writable ref store this module stopped trusting names
  // in. ls-remote's answer is read straight off this process's own stdout, in memory, before
  // anything is written to disk; rev-parse is then asked about that exact object id, a
  // content-addressed lookup no planted ref can redirect. The fetch itself may still be
  // redirected — it has to run inside the clone to write objects there — but that is harmless:
  // a server the agent points us at cannot make *this* sha appear.
  async function resolveFreshBase(env: () => NodeJS.ProcessEnv, url: string): Promise<string> {
    const ref = `refs/heads/${config.baseBranch}`;
    const neutral = tmpdir();
    const lsRemote = await remoteRun(env, neutral, ["ls-remote", "--", url, ref], {
      GIT_CEILING_DIRECTORIES: neutral,
    });
    if (lsRemote.code !== 0) {
      throw new Error(
        `could not read ${ref} from ${url} (${lsRemote.stderr || lsRemote.stdout || "ls-remote failed"})`
      );
    }

    const remoteSha = shaForExactRef(lsRemote.stdout, ref);
    if (!remoteSha) {
      throw new Error(`${url} did not report ${ref}`);
    }

    // `--` guards both positional arguments: without it a value beginning with a dash is read as
    // an option, and --upload-pack=<cmd> runs that command. delivery.ts guards its push the same
    // way, for the same reason.
    const fetched = await remoteRun(env, config.repoPath, [
      "fetch",
      "--no-tags",
      "--",
      url,
      config.baseBranch,
    ]);
    if (fetched.code !== 0) {
      throw new Error(
        `could not fetch ${config.baseBranch} from ${url} (${fetched.stderr || fetched.stdout || "fetch failed"})`
      );
    }

    // `^{commit}` is load-bearing: `rev-parse --verify <sha>` exits 0 for an object that is not
    // present, while `<sha>^{commit}` requires it locally and refuses a tag or a blob.
    return (await git(["rev-parse", "--verify", `${remoteSha}^{commit}`])).trim();
  }

  // There is deliberately no fallback to the local ref. That ref is writable by the agent of any
  // run that has ever executed against this checkout and it survives between runs, so reading it
  // is the vulnerability this module exists to close — and an agent can force a fallback on
  // purpose by planting an http.proxy or an insteadOf that points at nothing. A base that cannot
  // be verified fails the run instead: an operator sees why, and no gate ever judges a diff
  // against a base somebody else chose.
  async function resolveBase(): Promise<string> {
    if (!remoteEnv || !remoteUrl) {
      throw new Error(
        `no remote is configured for this checkout, so ${config.baseBranch} could only be read from the local ref store, which a previous run's agent can write`
      );
    }
    return resolveFreshBase(remoteEnv, remoteUrl);
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
