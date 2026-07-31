import { describe, it, expect, vi } from "vitest";
import { collectDiff } from "./diff.js";

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

  it("bounds a patch that exceeds the size limit instead of holding it unbounded in memory", async () => {
    const hugePatch = "x".repeat(250_000);
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "1\t0\tsrc/a.ts\n", stderr: "", timedOut: false })
      .mockResolvedValueOnce({ code: 0, stdout: hugePatch, stderr: "", timedOut: false });

    const diff = await collectDiff({ run }, "/wt", "main");

    expect(diff.patch.length).toBeLessThan(hugePatch.length);
    expect(diff.patch).toMatch(/truncated/);
  });
});
