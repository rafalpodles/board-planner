import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { CommandResult, Runner } from "./exec.js";
import { gitArgs, localGitEnv, requireGitPath } from "./git-safety.js";

const TIMEOUT_MS = 60_000;
const NAMED_AT_MOST = 5;
const REGULAR_BLOB = /^(100644|100755) blob ([0-9a-f]+)\t(.*)$/s;

export type HiddenFiles =
  | { kind: "hidden"; detail: string }
  | { kind: "unreadable"; detail: string };

class Unreadable extends Error {}

interface GitOptions {
  cwd?: string;
  stdin?: string;
  okCodes?: number[];
  bytes?: boolean;
}

function nulFields(stdout: string): string[] {
  const fields = stdout.split("\0");
  if (fields[fields.length - 1] === "") fields.pop();
  return fields;
}

// check-ignore reads each stdin line as a pathspec, so `:evil/` is top-magic for `evil/` and is
// matched against nothing. `./` makes every path a plain one; --literal-pathspecs makes check-ignore
// refuse to run at all.
const asPath = (path: string) => `./${path}`;
const fromPath = (echoed: string) => (echoed.startsWith("./") ? echoed.slice(2) : echoed);
const pathsOnStdin = (paths: string[]) => paths.map((path) => `${asPath(path)}\0`).join("");

// Only a .gitignore in a directory above a path can decide whether it is ignored
function gitignoresAbove(paths: string[]): string[] {
  const found = new Set<string>();
  for (const path of paths) {
    const segments = path.replace(/\/$/, "").split("/");
    for (let depth = 0; depth < segments.length; depth += 1) {
      found.add([...segments.slice(0, depth), ".gitignore"].join("/"));
    }
  }
  return [...found];
}

function safeRelative(path: string): boolean {
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Untracked files git has been told to ignore that the repository's own `.gitignore` files, as the
 * base commit has them, would not ignore (BP-640).
 *
 * An ignored path is invisible to `git status --porcelain` and to `git add --all`, so it reaches no
 * commit, no diff and no gate — and the Test gate still runs it if the suite globs it. The rules the
 * agent can write are `.git/info/exclude` (unconfined, or through a `.git` pointer redirected to a
 * git dir inside the worktree, which a confined agent can write), a nested `.gitignore` (which can
 * ignore itself), and an edit to a tracked one — including a deletion or a reordering that makes a
 * base line decide. No config key turns `info/exclude` off, so the base commit's `.gitignore` files
 * are written into an empty repository of their own and `check-ignore` is asked there whether they
 * ignore each path; the worktree's `check-ignore -v` only names the rule that hid one.
 *
 * `--directory` is what keeps this off npm ci's tree: an ignored `node_modules/` is one entry, not
 * thirty thousand. Nothing here reads a file through a filter: blobs come from `cat-file blob`, and
 * nothing hashes or stages the worktree.
 */
export async function hiddenFromGit(
  runner: Runner,
  gitPath: string,
  worktreePath: string,
  baseSha: string,
): Promise<HiddenFiles | null> {
  const git = async (what: string, args: string[], options: GitOptions = {}) => {
    const result: CommandResult = await runner.run(requireGitPath(gitPath), gitArgs(args), {
      cwd: options.cwd ?? worktreePath,
      timeoutMs: TIMEOUT_MS,
      env: localGitEnv(),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.bytes ? { stdoutEncoding: "latin1" as const } : {}),
    });
    if (result.timedOut) throw new Unreadable(`\`git ${what}\` timed out after ${TIMEOUT_MS}ms`);
    if (!(options.okCodes ?? [0]).includes(result.code)) {
      throw new Unreadable(`\`git ${what}\` failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout;
  };

  try {
    const ignored = nulFields(
      await git("ls-files", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]),
    );
    if (ignored.length === 0) return null;

    const ignoredAtBase = await ignoredByBaseRules(git, baseSha, ignored);
    // `--directory` also lists an unignored directory whose entries are all ignored, and lists
    // those entries too — they are what is judged
    const parentsOfListed = new Set<string>();
    for (const path of ignored) {
      for (let slash = path.indexOf("/"); slash !== -1 && slash < path.length - 1; slash = path.indexOf("/", slash + 1)) {
        parentsOfListed.add(path.slice(0, slash + 1));
      }
    }
    const offenders = ignored.filter((path) => !ignoredAtBase.has(path) && !parentsOfListed.has(path));
    if (offenders.length === 0) return null;

    const rules = new Map<string, string>();
    // 1 is check-ignore's "none of these is ignored", not a failure
    const fields = nulFields(
      await git("check-ignore", ["check-ignore", "--verbose", "-z", "--stdin"], {
        stdin: pathsOnStdin(offenders),
        okCodes: [0, 1],
      }),
    );
    for (let at = 0; at + 3 < fields.length; at += 4) {
      rules.set(fromPath(fields[at + 3]), `${fields[at]}:${fields[at + 1]}: ${JSON.stringify(fields[at + 2])}`);
    }

    const named = offenders
      .slice(0, NAMED_AT_MOST)
      .map((path) => `${path} (${rules.get(path) ?? "git names no rule for it"})`)
      .join(", ");
    const more = offenders.length > NAMED_AT_MOST ? `, and ${offenders.length - NAMED_AT_MOST} more` : "";
    return {
      kind: "hidden",
      detail: `files git is told to ignore that the repository's own .gitignore as of the base commit does not ignore, so no commit, diff or gate would see them: ${named}${more}`,
    };
  } catch (error) {
    if (error instanceof Unreadable) return { kind: "unreadable", detail: error.message };
    throw error;
  }
}

// `cat-file --batch` frames each blob by its size in bytes, so its stdout arrives as latin1
function blobsFromBatch(stdout: string, count: number): Buffer[] {
  const bytes = Buffer.from(stdout, "latin1");
  const blobs: Buffer[] = [];
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    const headerEnd = bytes.indexOf(0x0a, at);
    const header = bytes.subarray(at, headerEnd).toString("utf8").split(" ");
    const size = Number(header[2]);
    if (headerEnd === -1 || header[1] !== "blob" || !Number.isInteger(size)) {
      throw new Unreadable("`git cat-file` answered in a shape this does not read");
    }
    blobs.push(bytes.subarray(headerEnd + 1, headerEnd + 1 + size));
    at = headerEnd + 1 + size + 1;
  }
  return blobs;
}

async function ignoredByBaseRules(
  git: (what: string, args: string[], options?: GitOptions) => Promise<string>,
  baseSha: string,
  paths: string[],
): Promise<Set<string>> {
  // The whole tree in one spawn rather than a pathspec per directory: a repository with thousands of
  // `__pycache__/` directories took the argument list past E2BIG
  const above = new Set(gitignoresAbove(paths));
  const listing = await git("ls-tree", ["ls-tree", "-r", "-z", "--full-tree", baseSha]);
  // A symlinked .gitignore is one git does not read
  const gitignores = nulFields(listing)
    .map((entry) => REGULAR_BLOB.exec(entry))
    .filter((entry): entry is RegExpExecArray => entry !== null && above.has(entry[3]) && safeRelative(entry[3]))
    .map((entry) => ({ blob: entry[2], path: entry[3] }));
  const contents =
    gitignores.length === 0
      ? []
      : blobsFromBatch(
          await git("cat-file", ["cat-file", "--batch"], {
            stdin: gitignores.map(({ blob }) => `${blob}\n`).join(""),
            bytes: true,
          }),
          gitignores.length,
        );

  // Seeded from the TMP volume, which on a Mac is case-insensitive where a clone's may not be: a
  // base `Dist/` would ignore a `dist/` here that the worktree's git never ignored
  const ignoreCase = (
    await git("config", ["config", "--bool", "core.ignoreCase"], { okCodes: [0, 1] })
  ).trim() === "true";

  const scratch = mkdtempSync(join(tmpdir(), "bp-base-ignores-"));
  try {
    gitignores.forEach(({ path }, index) => {
      const target = join(scratch, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents[index]);
    });
    // No template, so no info/exclude: the only rules in here are the base commit's
    await git("init", ["init", "--quiet", "--template="], { cwd: scratch });
    const echoed = await git(
      "check-ignore",
      ["-c", `core.ignoreCase=${ignoreCase}`, "check-ignore", "-z", "--stdin"],
      { cwd: scratch, stdin: pathsOnStdin(paths), okCodes: [0, 1] },
    );
    return new Set(nulFields(echoed).map(fromPath));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
