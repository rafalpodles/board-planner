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
  push(
    worktreePath: string,
    branch: string,
    commit: string,
    configBaseline?: readonly string[] | null,
  ): Promise<void>;
  openPr(
    worktreePath: string,
    task: ClaimedTask,
    summary: string,
  ): Promise<string>;
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
  if (result.timedOut)
    return new Error(`${label} timed out after ${TIMEOUT_MS}ms${suffix}`);
  return new Error(
    `${label} failed (exit ${result.code})${suffix}: ${outputTail(result)}`,
  );
}

function lastPrUrl(text: string): string {
  const matches = text.match(PR_URL);
  return matches ? matches[matches.length - 1] : "";
}

function prTitle(task: ClaimedTask): string {
  const title = scrub(`${task.taskKey}: ${task.title}`)
    .replace(/\s+/g, " ")
    .trim();
  return title.length <= MAX_TITLE_CHARS
    ? title
    : `${title.slice(0, MAX_TITLE_CHARS - 3)}...`;
}

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

const HARDENED_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["core.pager", "cat"],
  ["core.sshCommand", "ssh"],
  ["core.askPass", ""],
  ["credential.helper", ""],
  ["credential.helper", "!gh auth git-credential"],
  ["protocol.ext.allow", "never"],
  ["protocol.file.allow", "never"],
];

const RECEIVE_PACK = "--receive-pack=git-receive-pack";

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

export function createDelivery(
  runner: Runner,
  baseBranch?: string,
  githubToken?: string,
): Delivery {
  const trimmedBase = baseBranch?.trim() ?? "";
  const baseArgs =
    trimmedBase && isGitRefName(trimmedBase) ? ["--base", trimmedBase] : [];
  const pinnedIdentity: NodeJS.ProcessEnv = githubToken?.trim()
    ? { GH_TOKEN: githubToken.trim(), GITHUB_TOKEN: githubToken.trim() }
    : {};

  function run(
    command: string,
    args: string[],
    cwd: string,
  ): Promise<CommandResult> {
    return runner.run(command, args, {
      cwd,
      timeoutMs: TIMEOUT_MS,
      env: {
        ...childEnv([
          "SSH_AUTH_SOCK",
          "GH_TOKEN",
          "GITHUB_TOKEN",
          "GH_CONFIG_DIR",
          "XDG_CONFIG_HOME",
        ]),
        ...pinnedIdentity,
        ...hardenedGitConfig(),
      },
    });
  }

  async function refuseIfPlanted(
    worktreePath: string,
    configBaseline?: readonly string[] | null,
  ): Promise<void> {
    const planted = await plantedConfig(runner, worktreePath, configBaseline);
    if (planted) {
      throw new Error(
        `refusing to push: the checkout's git config sets ${planted}, which was not there when the repository was approved`,
      );
    }
  }

  async function mergeState(
    worktreePath: string,
    prUrl: string,
  ): Promise<MergeState> {
    const result = await run(
      "gh",
      ["pr", "view", prUrl, "--json", "state", ...repoArgs(prUrl)],
      worktreePath,
    );
    if (result.code !== 0) return "unknown";
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (!isRecord(parsed) || typeof parsed.state !== "string")
        return "unknown";
      return parsed.state === "MERGED" ? "merged" : "unmerged";
    } catch {
      return "unknown";
    }
  }

  return {
    async push(worktreePath, branch, commit, configBaseline) {
      if (!commit) throw new Error("refusing to push: no commit was named");
      if (!isGitRefName(branch)) {
        throw new Error(
          `refusing to push: ${JSON.stringify(branch)} is not a git ref name, and the push refspec is built from it`,
        );
      }
      await refuseIfPlanted(worktreePath);
      const result = await run(
        "git",
        refuseOptionShapedPositionals([
          "push",
          "--no-verify",
          RECEIVE_PACK,
          "--force-with-lease",
          "origin",
          "--",
          `${commit}:refs/heads/${branch}`,
        ]),
        worktreePath,
      );
      if (result.code !== 0) throw failure("git push", result);
    },

    async openPr(worktreePath, task, summary) {
      const result = await run(
        "gh",
        [
          "pr",
          "create",
          "--title",
          prTitle(task),
          "--body",
          prBody(summary),
          ...baseArgs,
        ],
        worktreePath,
      );

      if (result.code === 0) {
        const url = lastPrUrl(result.stdout) || lastPrUrl(result.stderr);
        if (!url) {
          throw new Error(
            `gh pr create printed no pull request url: ${outputTail(result)}`,
          );
        }
        return url;
      }

      const output = `${result.stdout}\n${result.stderr}`;
      const existing = lastPrUrl(output);
      if (existing && /already exists/i.test(output)) return existing;

      throw failure("gh pr create", result);
    },

    async merge(worktreePath, prUrl) {
      const result = await run(
        "gh",
        [
          "pr",
          "merge",
          prUrl,
          "--merge",
          "--delete-branch",
          ...repoArgs(prUrl),
        ],
        worktreePath,
      );
      if (result.code === 0) return;

      const state = await mergeState(worktreePath, prUrl);
      if (state === "merged") return;
      throw failure(
        "gh pr merge",
        result,
        state === "unknown" ? "merge state could not be confirmed" : "",
      );
    },
  };
}
