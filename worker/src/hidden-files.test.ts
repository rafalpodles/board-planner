import { describe, it, expect, vi } from "vitest";
import { CommandResult, Runner } from "./exec.js";
import { hiddenFromGit } from "./hidden-files.js";

const gitPath = "/opt/homebrew/bin/git";

function shell(stdout = "", overrides: Partial<CommandResult> = {}): CommandResult {
  return { code: 0, stdout, stderr: "", timedOut: false, ...overrides };
}

// One hidden path, the base's root .gitignore not ignoring it; `failing` answers as git failing
function runnerFailing(failing: (args: string[]) => boolean, failure: Partial<CommandResult>): Runner {
  return {
    run: vi.fn<Runner["run"]>(async (_command, args) => {
      if (failing(args)) return shell("", failure);
      if (args.includes("ls-files")) return shell("evil.test.ts\0");
      if (args.includes("ls-tree")) return shell("100644 blob abc123\t.gitignore\0");
      if (args.includes("cat-file")) return shell("node_modules/\n");
      if (args.includes("init")) return shell();
      if (args.includes("check-ignore") && args.includes("--verbose")) {
        return shell("/main/.git/info/exclude\x001\x00evil.test.ts\x00./evil.test.ts\x00");
      }
      return shell("", { code: 1 });
    }),
  };
}

describe("hiddenFromGit when git will not answer", () => {
  const cases: [string, (args: string[]) => boolean][] = [
    ["ls-files", (args) => args.includes("ls-files")],
    ["ls-tree", (args) => args.includes("ls-tree")],
    ["cat-file", (args) => args.includes("cat-file")],
    ["init", (args) => args.includes("init")],
    ["check-ignore", (args) => args.includes("check-ignore") && !args.includes("--verbose")],
    ["check-ignore", (args) => args.includes("check-ignore") && args.includes("--verbose")],
  ];

  for (const [what, failing] of cases) {
    it(`reads a failed ${what} as unreadable, not as nothing hidden`, async () => {
      const found = await hiddenFromGit(runnerFailing(failing, { code: 128, stderr: "fatal: boom" }), gitPath, "/wt", "base1");

      expect(found).toEqual({ kind: "unreadable", detail: `\`git ${what}\` failed: fatal: boom` });
    });
  }

  it("reads a timeout as unreadable", async () => {
    const found = await hiddenFromGit(
      runnerFailing((args) => args.includes("ls-tree"), { timedOut: true }),
      gitPath,
      "/wt",
      "base1",
    );

    expect(found).toEqual({ kind: "unreadable", detail: "`git ls-tree` timed out after 60000ms" });
  });

  it("names the rule when every call answers", async () => {
    const found = await hiddenFromGit(runnerFailing(() => false, {}), gitPath, "/wt", "base1");

    expect(found?.detail).toContain('evil.test.ts (/main/.git/info/exclude:1: "evil.test.ts")');
  });
});
