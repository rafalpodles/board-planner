import { describe, it, expect, vi } from "vitest";
import { CommandResult } from "./exec.js";
import { gitArgs } from "./git-safety.js";
import { collectDiff } from "./diff.js";

// Every call carries the hardening flags gitArgs prepends — stripped here so recorded calls and
// response keys stay about the git subcommand, the same convention workspace.test.ts uses.
const HARDENING_PREFIX = gitArgs([]);

function recordingRunner(calls: string[][], responses: Record<string, Partial<CommandResult>> = {}) {
  const run = vi.fn(async (_command: string, args: string[]): Promise<CommandResult> => {
    const stripped = args.slice(HARDENING_PREFIX.length);
    calls.push(stripped);
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...responses[stripped[0]] };
  });
  return { run };
}

describe("collectDiff", () => {
  it("counts changed lines and files from numstat", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        stdout: "3\t1\tsrc/a.ts\n10\t0\tsrc/a.test.ts\n",
        stderr: "",
        timedOut: false,
      })
      .mockResolvedValueOnce({ code: 0, stdout: "diff --git ...", stderr: "", timedOut: false });

    const diff = await collectDiff({ run }, "/wt", "main");

    expect(diff.changedFiles).toEqual(["src/a.ts", "src/a.test.ts"]);
    expect(diff.changedLines).toBe(14);
    expect(diff.patch).toBe("diff --git ...");
    expect(diff.truncated).toBe(false);
  });

  it("treats binary markers as zero lines", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "-\t-\timage.png\n", stderr: "", timedOut: false })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "", timedOut: false });

    const diff = await collectDiff({ run }, "/wt", "main");

    expect(diff.changedLines).toBe(0);
    expect(diff.changedFiles).toEqual(["image.png"]);
  });

  it("resolves a renamed file to its post-rename path, in both numstat shorthands", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        stdout: "0\t0\tsrc/{old => new}/a.ts\n2\t1\told-name.ts => new-name.ts\n",
        stderr: "",
        timedOut: false,
      })
      .mockResolvedValueOnce({ code: 0, stdout: "diff --git ...", stderr: "", timedOut: false });

    const diff = await collectDiff({ run }, "/wt", "main");

    expect(diff.changedFiles).toEqual(["src/new/a.ts", "new-name.ts"]);
    expect(diff.changedLines).toBe(3);
  });

  it("throws a specific error when the numstat call fails, instead of proceeding with nothing", async () => {
    const run = vi.fn().mockResolvedValue({
      code: 128,
      stdout: "",
      stderr: "fatal: ambiguous argument 'main...HEAD': unknown revision or path not in the working tree",
      timedOut: false,
    });

    await expect(collectDiff({ run }, "/wt", "main")).rejects.toThrow(/unknown revision/);
  });

  it("throws when a git call times out, instead of silently returning empty output", async () => {
    const run = vi.fn().mockResolvedValue({ code: -1, stdout: "", stderr: "", timedOut: true });

    await expect(collectDiff({ run }, "/wt", "main")).rejects.toThrow(/timed out/);
  });

  it("throws when the patch call fails, instead of silently returning a truncated patch", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "1\t0\tsrc/a.ts\n", stderr: "", timedOut: false })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "out of memory", timedOut: false });

    await expect(collectDiff({ run }, "/wt", "main")).rejects.toThrow(/out of memory/);
  });

  it("does not truncate a patch exactly at the size limit", async () => {
    const patchAtLimit = "x".repeat(200_000);
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "1\t0\tsrc/a.ts\n", stderr: "", timedOut: false })
      .mockResolvedValueOnce({ code: 0, stdout: patchAtLimit, stderr: "", timedOut: false });

    const diff = await collectDiff({ run }, "/wt", "main");

    expect(diff.patch).toBe(patchAtLimit);
    expect(diff.truncated).toBe(false);
  });

  it("truncates a patch one character past the size limit, at an exact pinned boundary", async () => {
    const oversizedPatch = "x".repeat(200_001);
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "1\t0\tsrc/a.ts\n", stderr: "", timedOut: false })
      .mockResolvedValueOnce({ code: 0, stdout: oversizedPatch, stderr: "", timedOut: false });

    const diff = await collectDiff({ run }, "/wt", "main");

    expect(diff.patch).toBe(
      `${"x".repeat(200_000)}\n\n[patch truncated: exceeded 200000 characters]`,
    );
    expect(diff.truncated).toBe(true);
  });

  it("compares the two trees directly, so no history can narrow it", async () => {
    const calls: string[][] = [];
    const runner = recordingRunner(calls, { diff: { stdout: "" } });

    await collectDiff(runner, "/wt", "base111");

    const ranges = calls.filter((c) => c[0] === "diff").map((c) => c.slice(-2).join(" "));
    expect(ranges).toEqual(["base111 HEAD", "base111 HEAD"]);
    expect(calls.flat().join(" ")).not.toContain("...");
  });

  // GIT_CONFIG_NOSYSTEM neutralises only the *system* gitconfig. It says nothing about a
  // repository's own .git/config or .git/info/attributes — diff.external and diff.*.textconv,
  // both live there, are what --no-ext-diff and --no-textconv exist to close (see collectDiff and
  // the real-git tests in diff.ext-diff-and-textconv.integration.test.ts). This test only pins the
  // two things it actually asserts.
  it("passes -c core.pager=cat and GIT_CONFIG_NOSYSTEM=1 on every call it makes", async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "", timedOut: false });
    await collectDiff({ run }, "/wt", "main");

    expect(run.mock.calls.length).toBeGreaterThan(0);
    for (const call of run.mock.calls) {
      expect(call[1]).toEqual(expect.arrayContaining(["-c", "core.pager=cat"]));
      expect(call[2].env.GIT_CONFIG_NOSYSTEM).toBe("1");
    }
  });
});
