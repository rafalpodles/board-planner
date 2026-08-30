import { describe, it, expect, vi } from "vitest";
import { CommandResult } from "./exec.js";
import { gitArgs } from "./git-safety.js";
import { collectDiff } from "./diff.js";

// Every call carries the hardening flags gitArgs prepends — stripped here so recorded calls and
// response keys stay about the git subcommand, the same convention workspace.test.ts uses.
const HARDENING_PREFIX = gitArgs([]);
const BASE_SHA = "abc1234";
// BP-404: collectDiff resolves HEAD to an object id before it reads anything, and names that id in
// both diffs, so the review gate can check out the same commit the gates judged. Every stub here
// answers that call first.
const HEAD_SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
const HEAD_RESOLVED = { code: 0, stdout: `${HEAD_SHA}\n`, stderr: "", timedOut: false };
// BP-509: collectDiff reads `--raw` between the numstat and the patch, for the file modes numstat
// cannot express. Empty means "this change added no symlink".
const NO_SYMLINKS = { code: 0, stdout: "", stderr: "", timedOut: false };

function recordingRunner(calls: string[][], responses: Record<string, Partial<CommandResult>> = {}) {
  const run = vi.fn(async (_command: string, args: string[]): Promise<CommandResult> => {
    const stripped = args.slice(HARDENING_PREFIX.length);
    calls.push(stripped);
    const fallback = stripped[0] === "rev-parse" ? HEAD_RESOLVED : {};
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...fallback, ...responses[stripped[0]] };
  });
  return { run };
}

describe("collectDiff", () => {
  it("counts changed lines and files from numstat", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(HEAD_RESOLVED)
      .mockResolvedValueOnce({
        code: 0,
        stdout: "3\t1\tsrc/a.ts\n10\t0\tsrc/a.test.ts\n",
        stderr: "",
        timedOut: false,
      })
      .mockResolvedValueOnce(NO_SYMLINKS)
      .mockResolvedValueOnce({ code: 0, stdout: "diff --git ...", stderr: "", timedOut: false });

    const diff = await collectDiff({ run }, "/wt", BASE_SHA);

    expect(diff.changedFiles).toEqual(["src/a.ts", "src/a.test.ts"]);
    expect(diff.changedLines).toBe(14);
    expect(diff.patch).toBe("diff --git ...");
    expect(diff.truncated).toBe(false);
  });

  it("treats binary markers as zero lines", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(HEAD_RESOLVED)
      .mockResolvedValueOnce({ code: 0, stdout: "-\t-\timage.png\n", stderr: "", timedOut: false })
      .mockResolvedValueOnce(NO_SYMLINKS)
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "", timedOut: false });

    const diff = await collectDiff({ run }, "/wt", BASE_SHA);

    expect(diff.changedLines).toBe(0);
    expect(diff.changedFiles).toEqual(["image.png"]);
  });

  it("resolves a renamed file to its post-rename path, in both numstat shorthands", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(HEAD_RESOLVED)
      .mockResolvedValueOnce({
        code: 0,
        stdout: "0\t0\tsrc/{old => new}/a.ts\n2\t1\told-name.ts => new-name.ts\n",
        stderr: "",
        timedOut: false,
      })
      .mockResolvedValueOnce(NO_SYMLINKS)
      .mockResolvedValueOnce({ code: 0, stdout: "diff --git ...", stderr: "", timedOut: false });

    const diff = await collectDiff({ run }, "/wt", BASE_SHA);

    expect(diff.changedFiles).toEqual(["src/new/a.ts", "new-name.ts"]);
    expect(diff.changedLines).toBe(3);
  });

  it("throws a specific error when the numstat call fails, instead of proceeding with nothing", async () => {
    const run = vi.fn().mockResolvedValue({
      code: 128,
      stdout: "",
      stderr: "fatal: ambiguous argument 'abc1234': unknown revision or path not in the working tree",
      timedOut: false,
    });

    await expect(collectDiff({ run }, "/wt", BASE_SHA)).rejects.toThrow(/unknown revision/);
  });

  it("throws when a git call times out, instead of silently returning empty output", async () => {
    const run = vi.fn().mockResolvedValue({ code: -1, stdout: "", stderr: "", timedOut: true });

    await expect(collectDiff({ run }, "/wt", BASE_SHA)).rejects.toThrow(/timed out/);
  });

  it("throws when the patch call fails, instead of silently returning a truncated patch", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(HEAD_RESOLVED)
      .mockResolvedValueOnce({ code: 0, stdout: "1\t0\tsrc/a.ts\n", stderr: "", timedOut: false })
      .mockResolvedValueOnce(NO_SYMLINKS)
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "out of memory", timedOut: false });

    await expect(collectDiff({ run }, "/wt", BASE_SHA)).rejects.toThrow(/out of memory/);
  });

  it("does not truncate a patch exactly at the size limit", async () => {
    const patchAtLimit = "x".repeat(200_000);
    const run = vi
      .fn()
      .mockResolvedValueOnce(HEAD_RESOLVED)
      .mockResolvedValueOnce({ code: 0, stdout: "1\t0\tsrc/a.ts\n", stderr: "", timedOut: false })
      .mockResolvedValueOnce(NO_SYMLINKS)
      .mockResolvedValueOnce({ code: 0, stdout: patchAtLimit, stderr: "", timedOut: false });

    const diff = await collectDiff({ run }, "/wt", BASE_SHA);

    expect(diff.patch).toBe(patchAtLimit);
    expect(diff.truncated).toBe(false);
  });

  it("truncates a patch one character past the size limit, at an exact pinned boundary", async () => {
    const oversizedPatch = "x".repeat(200_001);
    const run = vi
      .fn()
      .mockResolvedValueOnce(HEAD_RESOLVED)
      .mockResolvedValueOnce({ code: 0, stdout: "1\t0\tsrc/a.ts\n", stderr: "", timedOut: false })
      .mockResolvedValueOnce(NO_SYMLINKS)
      .mockResolvedValueOnce({ code: 0, stdout: oversizedPatch, stderr: "", timedOut: false });

    const diff = await collectDiff({ run }, "/wt", BASE_SHA);

    expect(diff.patch).toBe(
      `${"x".repeat(200_000)}\n\n[patch truncated: exceeded 200000 characters]`,
    );
    expect(diff.truncated).toBe(true);
  });

  it("compares the two trees directly, so no history can narrow it", async () => {
    const calls: string[][] = [];
    const runner = recordingRunner(calls, { diff: { stdout: "" } });

    await collectDiff(runner, "/wt", BASE_SHA);

    // Three since BP-509: numstat, raw, patch — all three name the two trees
    const diffCalls = calls.filter((c) => c[0] === "diff");
    expect(diffCalls).toHaveLength(3);
    for (const call of diffCalls) {
      expect(call[call.length - 1]).toBe("--");
      // The object id, not the ref: HEAD is a file the agent can rewrite between the two calls,
      // and the review gate checks this same id out (BP-404)
      expect(call.slice(-3, -1)).toEqual([BASE_SHA, HEAD_SHA]);
    }
    expect(calls.flat().join(" ")).not.toContain("...");
  });

  // GIT_CONFIG_NOSYSTEM neutralises only the *system* gitconfig. It says nothing about a
  // repository's own .git/config or .git/info/attributes — diff.external and diff.*.textconv,
  // both live there, are what --no-ext-diff and --no-textconv exist to close (see collectDiff and
  // the real-git tests in diff.ext-diff-and-textconv.integration.test.ts). This test only pins the
  // two things it actually asserts.
  it("passes -c core.pager=cat and GIT_CONFIG_NOSYSTEM=1 on every call it makes", async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "", timedOut: false });
    run.mockResolvedValueOnce(HEAD_RESOLVED);
    await collectDiff({ run }, "/wt", BASE_SHA);

    expect(run.mock.calls.length).toBeGreaterThan(0);
    for (const call of run.mock.calls) {
      expect(call[1]).toEqual(expect.arrayContaining(["-c", "core.pager=cat"]));
      expect(call[2].env.GIT_CONFIG_NOSYSTEM).toBe("1");
    }
  });

  // BP-327. baseBranch used to be project policy: free text on the server, and the first
  // positional here. Measured on git 2.50.1 — `git diff --numstat '--output=/tmp/pwned...HEAD'`
  // exits 0 and creates the file, under the operator's own uid on their own laptop. BP-382 changed
  // what arrives at this parameter to an object id resolved off the wire, but every one of these
  // values is still refused: none of them is hex, so the shape check below catches them before the
  // option-shaped ones would even reach a `--`.
  it.each([
    "--output=/tmp/pwned",
    "-o/tmp/pwned",
    "--ext-diff",
    "main; touch /tmp/pwned",
    "main branch",
    "",
    "  ",
  ])("refuses a base that is not an object id: %j", async (baseSha) => {
    const run = vi.fn();

    await expect(collectDiff({ run }, "/wt", baseSha)).rejects.toThrow(/object id/i);
    expect(run).not.toHaveBeenCalled();
  });

  // BP-382 retargeted this guard from "is it a ref name" to "is it an object id":
  // workspace.ts now resolves the base off the wire and hands collectDiff `rev-parse --verify`'s
  // own output, so a ref name reaching here would mean some caller went back to naming something
  // the agent can rewrite. The ref names main's test list accepted are exactly what must now be
  // refused.
  it("accepts an object id but refuses a ref name, even one branches actually have", async () => {
    for (const ref of ["main", "develop", "release/1.2", "v1.0", "feature/BP-327_fix"]) {
      const run = vi.fn();
      await expect(collectDiff({ run }, "/wt", ref)).rejects.toThrow(/object id/i);
      expect(run).not.toHaveBeenCalled();
    }

    const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "", timedOut: false });
    run.mockResolvedValueOnce(HEAD_RESOLVED);
    await expect(collectDiff({ run }, "/wt", BASE_SHA)).resolves.toBeDefined();
  });

  // The head is validated the way the base is, and for the same reason: it is spent as a positional
  // in two git calls and, since BP-404, checked out by the review gate. An answer that is not an
  // object id means some earlier assumption stopped holding, and this refuses rather than passing
  // it on. Nothing asserted this until the BP-404 review mutated it away and saw nothing go red.
  it("refuses a head that git did not answer with an object id", async () => {
    for (const answer of ["HEAD\n", "refs/heads/main\n", "", "not a sha\n"]) {
      const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "", timedOut: false });
      run.mockResolvedValueOnce({ code: 0, stdout: answer, stderr: "", timedOut: false });

      await expect(collectDiff({ run }, "/wt", BASE_SHA)).rejects.toThrow(/object id/i);
      // and it refuses before spending it: the two diffs never run
      expect(run.mock.calls).toHaveLength(1);
    }
  });

  // Second line behind the shape check: nothing after `--` can be read as a revision or an option
  it("closes the positional list with --", async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "", timedOut: false });
    run.mockResolvedValueOnce(HEAD_RESOLVED);

    await collectDiff({ run }, "/wt", BASE_SHA);

    // The rev-parse that resolves HEAD is deliberately not in this list: it takes no pathspec, so
    // there is no positional list to close, and its one argument is a revision by construction
    const diffCalls = run.mock.calls.filter((call) => call[1].includes("diff"));
    expect(diffCalls).toHaveLength(3);
    for (const call of diffCalls) {
      expect(call[1][call[1].length - 1]).toBe("--");
      expect(call[1]).toContain(BASE_SHA);
      expect(call[1]).toContain(HEAD_SHA);
    }
  });
});
