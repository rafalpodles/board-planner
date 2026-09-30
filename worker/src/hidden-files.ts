import { CommandResult, Runner } from "./exec.js";
import { gitArgs, localGitEnv, requireGitPath } from "./git-safety.js";

const TIMEOUT_MS = 60_000;
const NAMED_AT_MOST = 5;
const BLOB_AT_BASE = /^([0-9a-f]{40}|[0-9a-f]{64}) blob$/;

export type HiddenFiles =
  | { kind: "hidden"; detail: string }
  | { kind: "unreadable"; detail: string };

interface IgnoreMatch {
  source: string;
  line: string;
  pattern: string;
}

function nulFields(stdout: string): string[] {
  const fields = stdout.split("\0");
  if (fields[fields.length - 1] === "") fields.pop();
  return fields;
}

function failure(what: string, result: CommandResult): string {
  if (result.timedOut) return `\`git ${what}\` timed out after ${TIMEOUT_MS}ms`;
  return `\`git ${what}\` failed: ${result.stderr || result.stdout}`;
}

// A newline would misalign the line-framed batches below
function couldBeRepositoryRule(source: string): boolean {
  return !source.includes("\n") && (source === ".gitignore" || source.endsWith("/.gitignore"));
}

/**
 * Untracked files git has been told to ignore by a rule that is not one of the repository's own
 * `.gitignore` files exactly as the base commit has them (BP-640).
 *
 * An ignored path is invisible to `git status --porcelain` and to `git add --all`, so it reaches no
 * commit, no diff and no gate — and the Test gate still runs it if the suite globs it. The rules
 * that do this and that the agent can write are `.git/info/exclude` (unconfined, or through a `.git`
 * pointer redirected to a git dir inside the worktree, which a confined agent can write), a new
 * nested `.gitignore` (which can ignore itself), and an edit to a tracked one. No config key turns
 * `info/exclude` off, so the rule each path is ignored by is asked of `check-ignore -v`, and only a
 * `.gitignore` whose bytes equal its blob at `baseSha` is let through.
 *
 * `--directory` is what keeps this off npm ci's tree: an ignored `node_modules/` is one entry, not
 * thirty thousand. No call here reads a file's content through a filter.
 */
export async function hiddenFromGit(
  runner: Runner,
  gitPath: string,
  worktreePath: string,
  baseSha: string,
): Promise<HiddenFiles | null> {
  const git = (args: string[], stdin: string | undefined) =>
    runner.run(requireGitPath(gitPath), gitArgs(args), {
      cwd: worktreePath,
      timeoutMs: TIMEOUT_MS,
      env: localGitEnv(),
      ...(stdin === undefined ? {} : { stdin }),
    });

  const listed = await git(
    ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
    undefined,
  );
  if (listed.timedOut || listed.code !== 0) {
    return { kind: "unreadable", detail: failure("ls-files", listed) };
  }
  const ignored = nulFields(listed.stdout);
  if (ignored.length === 0) return null;

  const checked = await git(["check-ignore", "--verbose", "-z", "--stdin"], `${ignored.join("\0")}\0`);
  // 1 is check-ignore's "none of these is ignored", not a failure
  if (checked.timedOut || (checked.code !== 0 && checked.code !== 1)) {
    return { kind: "unreadable", detail: failure("check-ignore", checked) };
  }
  const fields = nulFields(checked.stdout);
  const matches = new Map<string, IgnoreMatch>();
  for (let at = 0; at + 3 < fields.length; at += 4) {
    matches.set(fields[at + 3], { source: fields[at], line: fields[at + 1], pattern: fields[at + 2] });
  }

  const candidates = [...new Set([...matches.values()].map((match) => match.source))].filter(
    couldBeRepositoryRule,
  );
  const vetted = new Set<string>();
  if (candidates.length > 0) {
    const atBase = await git(
      ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
      candidates.map((source) => `${baseSha}:${source}\n`).join(""),
    );
    if (atBase.timedOut || atBase.code !== 0) {
      return { kind: "unreadable", detail: failure("cat-file", atBase) };
    }
    const inTree = await git(
      ["hash-object", "--no-filters", "--stdin-paths"],
      candidates.map((source) => `${source}\n`).join(""),
    );
    if (inTree.timedOut || inTree.code !== 0) {
      return { kind: "unreadable", detail: failure("hash-object", inTree) };
    }
    const baseLines = atBase.stdout.split("\n");
    const treeLines = inTree.stdout.split("\n");
    candidates.forEach((source, index) => {
      const blob = BLOB_AT_BASE.exec(baseLines[index] ?? "");
      if (blob && blob[1] === treeLines[index]) vetted.add(source);
    });
  }

  const offenders: string[] = [];
  for (const path of ignored) {
    const match = matches.get(path);
    if (!match) {
      // `--directory` also lists an unignored directory whose every entry is ignored, and lists
      // those entries too; a file with no rule is a disagreement between git's two answers
      if (!path.endsWith("/")) offenders.push(`${path} (git names no rule for it)`);
      continue;
    }
    if (!vetted.has(match.source)) {
      offenders.push(`${path} (${match.source}:${match.line}: ${JSON.stringify(match.pattern)})`);
    }
  }
  if (offenders.length === 0) return null;

  const named = offenders.slice(0, NAMED_AT_MOST).join(", ");
  const more = offenders.length > NAMED_AT_MOST ? `, and ${offenders.length - NAMED_AT_MOST} more` : "";
  return {
    kind: "hidden",
    detail: `files git is told to ignore by a rule that is not the repository's own .gitignore as of the base commit, so no commit, diff or gate would see them: ${named}${more}`,
  };
}
