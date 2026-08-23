import { isGitRefName } from "./config.js";
import { childEnv } from "./env.js";
import { CommandResult, Runner } from "./exec.js";
import { GIT_SAFE_ENV, refuseOptionShapedPositionals } from "./git-safety.js";
import { plantedConfig } from "./repos.js";
import { ClaimedTask } from "./types.js";
import { scrub } from "./scrub.js";

const TIMEOUT_MS = 120_000;
const MAX_TITLE_CHARS = 256;
const MAX_BODY_CHARS = 30_000;
const MAX_OUTPUT_CHARS = 2000;

const PR_URL = /https?:\/\/[^\s"'<>]*\/pull\/\d+/g;

export interface Delivery {
  push(worktreePath: string, branch: string): Promise<void>;
  openPr(worktreePath: string, task: ClaimedTask, summary: string): Promise<string>;
  merge(worktreePath: string, prUrl: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function outputTail(result: CommandResult): string {
  const output = [result.stdout, result.stderr]
    .filter((stream) => stream.trim())
    .join("\n")
    .trim();
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  return `[output truncated to the last ${MAX_OUTPUT_CHARS} characters]\n${output.slice(-MAX_OUTPUT_CHARS)}`;
}

function failure(label: string, result: CommandResult, note = ""): Error {
  const suffix = note ? ` (${note})` : "";
  if (result.timedOut) return new Error(`${label} timed out after ${TIMEOUT_MS}ms${suffix}`);
  return new Error(`${label} failed (exit ${result.code})${suffix}: ${outputTail(result)}`);
}

function lastPrUrl(text: string): string {
  const matches = text.match(PR_URL);
  return matches ? matches[matches.length - 1] : "";
}

function prTitle(task: ClaimedTask): string {
  const title = scrub(`${task.taskKey}: ${task.title}`).replace(/\s+/g, " ").trim();
  return title.length <= MAX_TITLE_CHARS ? title : `${title.slice(0, MAX_TITLE_CHARS - 3)}...`;
}

// Scrubbed here as well as on the board path. The PR body is the more public sink of the two —
// on a public repository a secret the agent quoted is published verbatim, while the board copy
// already showed [redacted] (BP-306).
function prBody(summary: string): string {
  const body = scrub(summary).trim();
  if (body.length <= MAX_BODY_CHARS) return body;
  return `${body.slice(0, MAX_BODY_CHARS)}\n\n[summary truncated to ${MAX_BODY_CHARS} characters]`;
}

function repoArgs(prUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(prUrl);
  } catch {
    return [];
  }
  const [owner, repo, pull] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo || pull !== "pull") return [];
  const host = url.host === "github.com" ? "" : `${url.host}/`;
  return ["--repo", `${host}${owner}/${repo}`];
}

type MergeState = "merged" | "unmerged" | "unknown";

// Order matters for credential.helper: the empty value clears whatever the repository or a global
// file configured, and the entry after it names the one helper we trust. Clearing alone would be a
// regression — GIT_CONFIG_GLOBAL below also hides the helper `gh auth setup-git` installs, so an
// https remote would stop authenticating.
const HARDENED_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["core.pager", "cat"],
  ["core.sshCommand", "ssh"],
  // Named by git when it wants a password and no helper answered. Empty disables it.
  ["core.askPass", ""],
  ["credential.helper", ""],
  ["credential.helper", "!gh auth git-credential"],
  // The transport, not the configuration, was the way through: `ext::` hands the URL to a program.
  // The agent cannot set our environment, but it can rewrite where the push goes —
  // `remote.origin.pushurl`, `remote.origin.url`, or `url.<ext::…>.insteadOf` — and the transport
  // is the one chokepoint that catches all three at once.
  //
  // `file` is refused for the same reason. It looks harmless — no program in the URL — but a local
  // push runs git-receive-pack against the destination, and that repository's own post-receive
  // hook then runs holding this environment. It does NOT inherit the hooksPath above; that was
  // assumed here once and the test written to confirm it failed instead.
  ["protocol.ext.allow", "never"],
  ["protocol.file.allow", "never"],
];

// `remote.<name>.receivepack` is deliberately not in the list above: git keeps the **first** value
// it is given for it rather than the last, so a repository setting wins over any override — with
// "more than one receivepack given, using the first" on stderr and exit 0, which nothing reads.
// The command line is the only place it can be won, so push passes it as a flag.
const RECEIVE_PACK = "--receive-pack=git-receive-pack";

// `core.gitProxy` is the receivepack quirk a second time: git keeps the **first** proxy entry it
// finds, so the repository's outranks anything the list above could say. Measured on git 2.50.1 —
// `none`, `none for *` and the empty string were each tried as an override and each lost, while a
// `git://` pushurl plus a planted proxy ran the agent's program holding GH_TOKEN, GITHUB_TOKEN and
// SSH_AUTH_SOCK. The environment is the one layer that wins, and an empty value there means "no
// proxy" rather than "fall through to the config", which is what makes it the fix. Refusing
// protocol.git would also work and costs the transport: with no proxy of the agent's choosing left
// to run, git:// is no more dangerous than https, and it is what the integration suite pushes over.
//
// NOSYSTEM drops /etc/gitconfig; GLOBAL=/dev/null drops ~/.gitconfig, which is as reachable to the
// agent as the repository's own — it holds HOME. The repository config cannot be pointed elsewhere,
// so the keys above override it instead, at the highest precedence git has.
export function hardenedGitConfig(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...GIT_SAFE_ENV,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_PROXY_COMMAND: "",
    GIT_CONFIG_COUNT: String(HARDENED_CONFIG.length),
  };
  HARDENED_CONFIG.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

// githubToken is the operator's pinned account, resolved by name at startup. Absent means what it
// has always meant: gh resolves its own identity from the keyring, and pushes act as whichever
// account is active. Present means the identity travels with the call, so a `gh auth switch` in
// another terminal — global machine state, shared with every process on the box — cannot decide
// mid-run who this worker pushes as (BP-373).
export function createDelivery(runner: Runner, baseBranch?: string, githubToken?: string): Delivery {
  // The second sink baseBranch reaches, after `git diff`. applyPolicy already refuses anything
  // that is not a ref name; dropping the flag here rather than passing it on means the worst a
  // value that got past it can do is open the pull request against the repository's own default.
  const trimmedBase = baseBranch?.trim() ?? "";
  const baseArgs = trimmedBase && isGitRefName(trimmedBase) ? ["--base", trimmedBase] : [];
  // Both names, not just the one gh prefers: an inherited GITHUB_TOKEN would otherwise decide the
  // identity behind the pin's back, and the failure it produces is a push that succeeds as the
  // wrong account rather than one that fails.
  const pinnedIdentity: NodeJS.ProcessEnv = githubToken?.trim()
    ? { GH_TOKEN: githubToken.trim(), GITHUB_TOKEN: githubToken.trim() }
    : {};

  // Delivery is the one place that may carry the credentials git and gh need for the remote — and
  // it runs inside the worktree the agent just wrote. The command is ours; what git *executes* on
  // our behalf is not. Every key below is a "run this program" hook, and the agent holds
  // `Bash(git *)` plus Write, so it can set any of them in the repository config — which a linked
  // worktree shares with the main clone, so what it plants outlives the run.
  //
  // Through GIT_CONFIG_* rather than `-c`, because the environment reaches the git that `gh`
  // shells out to; `-c` covers only the process we spawn ourselves. That is also why delivery does
  // not use git-safety's gitArgs like every other call site: HARDENED_CONFIG carries the same keys
  // and more, at the same precedence, and reaches gh's inner invocations as well.
  function run(command: string, args: string[], cwd: string): Promise<CommandResult> {
    return runner.run(command, args, {
      cwd,
      timeoutMs: TIMEOUT_MS,
      env: {
        ...childEnv(["SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"]),
        ...pinnedIdentity,
        ...hardenedGitConfig(),
      },
    });
  }

  // A second line, not the first: HARDENED_CONFIG overrides the keys it names, and this refuses
  // the push outright if the agent wrote an executable key at all — including one the list does
  // not name. Push is where it is worth paying for, being the call that hands the checkout's own
  // config a credential; gh carries its token in the environment, so openPr and merge do not.
  async function refuseIfPlanted(worktreePath: string): Promise<void> {
    const planted = await plantedConfig(runner, worktreePath);
    if (planted) {
      throw new Error(
        `refusing to push: the checkout's git config sets ${planted}, which was not there when the repository was approved`
      );
    }
  }

  async function mergeState(worktreePath: string, prUrl: string): Promise<MergeState> {
    const result = await run(
      "gh",
      ["pr", "view", prUrl, "--json", "state", ...repoArgs(prUrl)],
      worktreePath
    );
    if (result.code !== 0) return "unknown";
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (!isRecord(parsed) || typeof parsed.state !== "string") return "unknown";
      return parsed.state === "MERGED" ? "merged" : "unmerged";
    } catch {
      return "unknown";
    }
  }

  return {
    async push(worktreePath, branch) {
      // a retried attempt rebuilds the branch off the base, so what the previous attempt pushed is
      // a diverged history a plain push rejects; the lease still refuses to overwrite commits this
      // clone has never seen
      // -- keeps the branch in git's positional slot: without it a name beginning with a dash is
      // read as an option, and --receive-pack=<cmd> would run that command on the remote
      // --no-verify says the same thing as core.hooksPath above, in the one place it matters most:
      // two independent ways for a planted pre-push to be skipped, rather than one
      await refuseIfPlanted(worktreePath);
      const result = await run(
        "git",
        refuseOptionShapedPositionals([
          "push",
          "--no-verify",
          RECEIVE_PACK,
          "--force-with-lease",
          "-u",
          "origin",
          "--",
          branch,
        ]),
        worktreePath
      );
      if (result.code !== 0) throw failure("git push", result);
    },

    async openPr(worktreePath, task, summary) {
      const result = await run(
        "gh",
        ["pr", "create", "--title", prTitle(task), "--body", prBody(summary), ...baseArgs],
        worktreePath
      );

      if (result.code === 0) {
        const url = lastPrUrl(result.stdout) || lastPrUrl(result.stderr);
        if (!url) {
          throw new Error(`gh pr create printed no pull request url: ${outputTail(result)}`);
        }
        return url;
      }

      // the branch already carries an open pull request from an earlier attempt, and the push
      // above pointed it at the commits of this one
      const output = `${result.stdout}\n${result.stderr}`;
      const existing = lastPrUrl(output);
      if (existing && /already exists/i.test(output)) return existing;

      throw failure("gh pr create", result);
    },

    async merge(worktreePath, prUrl) {
      // --repo keeps gh out of the local checkout: --delete-branch otherwise switches the worktree
      // to the base branch first, which git refuses while the main clone has it checked out
      const result = await run(
        "gh",
        ["pr", "merge", prUrl, "--merge", "--delete-branch", ...repoArgs(prUrl)],
        worktreePath
      );
      if (result.code === 0) return;

      const state = await mergeState(worktreePath, prUrl);
      if (state === "merged") return;
      throw failure(
        "gh pr merge",
        result,
        state === "unknown" ? "merge state could not be confirmed" : ""
      );
    },
  };
}
