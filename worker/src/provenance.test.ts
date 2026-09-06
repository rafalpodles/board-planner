import { describe, it, expect } from "vitest";
import { unexpectedHistory } from "./provenance.js";

const runnerFor = (revList: string, head: string, code = 0) => ({
  run: async (_c: string, args: string[]) =>
    args.includes("rev-list")
      ? { code, stdout: revList, stderr: "", timedOut: false }
      : { code: 0, stdout: head, stderr: "", timedOut: false },
});

describe("unexpectedHistory", () => {
  it("passes when the range holds exactly the run's own commits", async () => {
    const runner = runnerFor("sha2\nsha1\n", "sha2\n");
    expect(await unexpectedHistory(runner as never, "/wt", "base", ["sha1", "sha2"])).toBe("");
  });

  it("refuses a commit the run did not make", async () => {
    const runner = runnerFor("shaX\nsha2\nsha1\n", "shaX\n");
    const reason = await unexpectedHistory(runner as never, "/wt", "base", ["sha1", "sha2"]);
    expect(reason).toContain("shaX");
  });

  it("refuses a HEAD that is not the run's last commit", async () => {
    const runner = runnerFor("sha2\nsha1\n", "sha1\n");
    expect(await unexpectedHistory(runner as never, "/wt", "base", ["sha1", "sha2"])).toMatch(/HEAD/);
  });

  it("refuses when the range cannot be read at all", async () => {
    const runner = runnerFor("", "sha2\n", 128);
    expect(await unexpectedHistory(runner as never, "/wt", "base", ["sha1", "sha2"])).toMatch(/rev-list/);
  });

  it("refuses when the range is missing one of the run's own commits", async () => {
    const runner = runnerFor("sha2\n", "sha2\n");
    const reason = await unexpectedHistory(runner as never, "/wt", "base", ["sha1", "sha2"]);
    expect(reason).toContain("1 commit(s)");
    expect(reason).toContain("this run made 2");
  });
});
