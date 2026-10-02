import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { CommandResult, Runner } from "./exec.js";
import { gitArgs, localGitEnv, requireGitPath } from "./git-safety.js";

const TIMEOUT_MS = 60_000;
const NAMED_AT_MOST = 5;
const REGULAR_BLOB = /^(100644|100755) blob ([0-9a-f]+)\t(.*)$/s;
const GITLINK = /^160000 [0-9a-f]+ \d\t(.*)$/s;
const UNWALKED = /^.*(could not open directory|failed to stat|cannot stat|unable to stat).*$/im;

export type HiddenFiles =
  | { kind: "hidden"; detail: string }
  | { kind: "nested"; detail: string }
  | { kind: "unreviewed"; detail: string }
  | { kind: "written"; detail: string; paths: string[]; named: string }
  | { kind: "unreadable"; detail: string };

export type IgnoredFiles =
  | { kind: "listed"; files: ReadonlyMap<string, string> }
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

type Git = (what: string, args: string[], options?: GitOptions) => Promise<string>;

function gitIn(runner: Runner, gitPath: string, worktreePath: string): Git {
  return async (what, args, options = {}) => {
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
    // git exits 0 over a directory it cannot open, and lists nothing under it (BP-795)
    const skipped = UNWALKED.exec(result.stderr);
    if (skipped) throw new Unreadable(`\`git ${what}\` could not read all of the worktree: ${skipped[0]}`);
    return result.stdout;
  };
}

/**
 * `status` that reports a submodule pointer change — staged, removed, or the directory gone — but
 * never asks the submodule itself whether it is dirty, which is the question that spawns git inside
 * it. Measured on git 2.54.0: `=dirty` prints `M lib` for a pointer bump and runs no filter planted
 * in `lib`; `=untracked` and `=none` run it; `=all` runs nothing and prints nothing for any pointer
 * change either, so a change that was only a bump was never committed and never reached
 * protected-paths. The flag outranks a `.gitmodules` `ignore =` in both directions.
 */
export const PORCELAIN_STATUS = ["status", "--porcelain", "--ignore-submodules=dirty"];

/**
 * A git repository inside the worktree that git would treat as a submodule (BP-803).
 *
 * Checking whether a submodule is dirty makes git spawn itself inside it with GIT_DIR cleared, and
 * that child reads the nested repository's own `.git/config` and `.gitattributes` — so a
 * `filter.<name>.clean` the agent planted there runs outside the sandbox, as this process's uid.
 * `PORCELAIN_STATUS` keeps the status calls out of it, but `git add` has no such switch: measured on
 * git 2.54.0, `add --all` over a staged gitlink runs `git status --porcelain=2 -uno` inside it
 * whatever the config says. So the repository is refused before anything stages. Not
 * `diff.ignoreSubmodules` in gitArgs either: `.gitmodules` outranks it, and at `all` it also blanks a
 * gitlink out of the tree-to-tree diff that protected-paths refuses a submodule bump on — measured.
 *
 * Two shapes, both answered without spawning into the nested repository (measured): a gitlink in the
 * index whose path now holds a `.git`, and an untracked nested repository, which `ls-files --others`
 * without `--directory` prints as one entry with a trailing slash. Ignored trees are not walked:
 * `add --all` never stages an ignored path, so no worker call reaches a repository inside one, and
 * `node_modules/` legitimately holds `.git` directories from git dependencies.
 */
export async function nestedRepositories(
  runner: Runner,
  gitPath: string,
  worktreePath: string,
): Promise<HiddenFiles | null> {
  try {
    return await nestedIn(gitIn(runner, gitPath, worktreePath), worktreePath);
  } catch (error) {
    if (error instanceof Unreadable) return { kind: "unreadable", detail: error.message };
    throw error;
  }
}

async function nestedIn(git: Git, worktreePath: string): Promise<HiddenFiles | null> {
  const populatedGitlinks = nulFields(await git("ls-files", ["ls-files", "-z", "--stage"]))
    .map((entry) => GITLINK.exec(entry)?.[1])
    .filter((path): path is string => path !== undefined && existsSync(join(worktreePath, path, ".git")));
  const untracked = nulFields(await git("ls-files", ["ls-files", "-z", "--others", "--exclude-standard"]))
    .filter((path) => path.endsWith("/"));
  const found = [
    ...populatedGitlinks.map((path) => `${path} (a submodule path with a .git in it)`),
    ...untracked.map((path) => `${path} (untracked)`),
  ];
  if (found.length === 0) return null;
  const more = found.length > NAMED_AT_MOST ? `, and ${found.length - NAMED_AT_MOST} more` : "";
  return {
    kind: "nested",
    detail: `a git repository nested inside the worktree, whose own config git would run outside the sandbox while checking the worktree, and whose contents reach no diff or gate: ${found.slice(0, NAMED_AT_MOST).join(", ")}${more}`,
  };
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
 *
 * A nested repository is asked about first, being the same hazard one level down: its contents
 * reach no diff either, and every checkpoint that asks this has to ask that (BP-803).
 */
export async function hiddenFromGit(
  runner: Runner,
  gitPath: string,
  worktreePath: string,
  baseSha: string,
  since?: IgnoredFiles,
): Promise<HiddenFiles | null> {
  const git = gitIn(runner, gitPath, worktreePath);

  try {
    const nested = await nestedIn(git, worktreePath);
    if (nested) return nested;

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
    if (offenders.length > 0) {
      return {
        kind: "hidden",
        detail: `files git is told to ignore that the repository's own .gitignore as of the base commit does not ignore, so no commit, diff or gate would see them: ${await describeWithRules(git, offenders)}`,
      };
    }
    if (!since) return null;
    if (since.kind === "unreadable") return since;

    const now = await listIgnored(git, worktreePath);
    const differs = [...now.keys()].filter((path) => since.files.get(path) !== now.get(path));
    const newTrees = differs.filter((path) => now.get(path) === NESTED_TREE && !since.files.has(path));
    const written = differs
      .filter((path) => !newTrees.some((tree) => path !== tree && path.startsWith(tree)))
      .sort((a, b) => Number(since.files.has(b)) - Number(since.files.has(a)));
    if (written.length === 0) return null;
    const rules = await rulesFor(git, written.slice(0, NAMED_AT_MOST));
    const changed = written.some((path) => since.files.has(path));
    const named = namedAtMost(written, (path) => `${since.files.has(path) ? "changed" : "new"}; ${rules.get(path) ?? NO_RULE}`);
    if (changed) {
      return {
        kind: "unreviewed",
        detail: `ignored files written since the run started or the last gate passed, which no commit, diff or reviewer sees while a gate can still run them: ${named}`,
      };
    }
    return {
      kind: "written",
      detail: `ignored files a step wrote, which no commit, diff or reviewer sees: ${named}`,
      paths: written,
      named,
    };
  } catch (error) {
    if (error instanceof Unreadable) return { kind: "unreadable", detail: error.message };
    throw error;
  }
}

const NO_RULE = "git names no rule for it";

async function rulesFor(git: Git, paths: string[]): Promise<Map<string, string>> {
  const rules = new Map<string, string>();
  // 1 is check-ignore's "none of these is ignored", not a failure
  const fields = nulFields(
    await git("check-ignore", ["check-ignore", "--verbose", "-z", "--stdin"], {
      stdin: pathsOnStdin(paths),
      okCodes: [0, 1],
    }),
  );
  for (let at = 0; at + 3 < fields.length; at += 4) {
    rules.set(fromPath(fields[at + 3]), `${fields[at]}:${fields[at + 1]}: ${JSON.stringify(fields[at + 2])}`);
  }
  return rules;
}

async function describeWithRules(git: Git, paths: string[]): Promise<string> {
  const rules = await rulesFor(git, paths);
  return namedAtMost(paths, (path) => rules.get(path) ?? NO_RULE);
}

function namedAtMost(paths: string[], describe: (path: string) => string): string {
  const named = paths
    .slice(0, NAMED_AT_MOST)
    .map((path) => `${path} (${describe(path)})`)
    .join(", ");
  return `${named}${paths.length > NAMED_AT_MOST ? `, and ${paths.length - NAMED_AT_MOST} more` : ""}`;
}

const NESTED_TREE = "a nested tree";
let unstattable = 0;

// Never equal to an earlier one: what cannot be read cannot be shown unchanged
function unreadableSignature(error: unknown): string {
  unstattable += 1;
  return `unstattable:${(error as NodeJS.ErrnoException).code ?? "unknown"}:${unstattable}`;
}

function signature(full: string): string | null {
  try {
    const stat = lstatSync(full, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return unreadableSignature(error);
  }
}

// git lists a nested repository under an ignored directory as one `dir/` entry and never enters it
function walkNested(worktreePath: string, directory: string, files: Map<string, string>): void {
  let entries;
  try {
    entries = readdirSync(join(worktreePath, directory), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") files.set(directory, unreadableSignature(error));
    return;
  }
  for (const entry of entries) {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory()) {
      walkNested(worktreePath, `${path}/`, files);
      continue;
    }
    const found = signature(join(worktreePath, path));
    if (found) files.set(path, found);
  }
}

// Not `--directory`: a file added under a `dist/` that already existed changes no entry of that
// listing. ctime is in the signature because a write cannot set it back.
async function listIgnored(git: Git, worktreePath: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const path of nulFields(
    await git("ls-files", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]),
  )) {
    if (path.endsWith("/")) {
      files.set(path, NESTED_TREE);
      walkNested(worktreePath, path, files);
      continue;
    }
    const found = signature(join(worktreePath, path));
    if (found) files.set(path, found);
  }
  return files;
}

// Taken at the start and after every gate, so what differs at the next gate a step wrote (BP-795)
export async function ignoredFiles(runner: Runner, gitPath: string, worktreePath: string): Promise<IgnoredFiles> {
  try {
    return { kind: "listed", files: await listIgnored(gitIn(runner, gitPath, worktreePath), worktreePath) };
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
  git: Git,
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
