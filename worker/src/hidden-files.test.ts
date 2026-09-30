import { readFileSync } from "fs";
import { join } from "path";
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
      if (args.includes("cat-file")) return shell("abc123 blob 13\nnode_modules/\n\n");
      if (args.includes("config")) return shell("false\n");
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
    ["config", (args) => args.includes("config")],
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

describe("hiddenFromGit on a tree with thousands of ignored directories", () => {
  it("keeps every git call's argument list small, whatever the number of directories", async () => {
    const directories = Array.from({ length: 12_000 }, (_, index) => `pkg/module${index}/__pycache__/`);
    const run = vi.fn<Runner["run"]>(async (_command, args, opts) => {
      if (args.includes("ls-files")) return shell(directories.map((path) => `${path}\0`).join(""));
      if (args.includes("ls-tree")) return shell("100644 blob abc123\t.gitignore\0");
      if (args.includes("cat-file")) return shell("abc123 blob 7\n*.pyc/\n\n");
      if (args.includes("config")) return shell("", { code: 1 });
      if (args.includes("check-ignore")) return shell(opts.stdin ?? "");
      return shell();
    });

    expect(await hiddenFromGit({ run }, gitPath, "/wt", "base1")).toBeNull();
    const longest = Math.max(...run.mock.calls.map(([, args]) => args.join(" ").length));
    expect(longest).toBeLessThan(4096);
  });
});

describe("hiddenFromGit reading the base's .gitignore files", () => {
  it("writes each blob byte for byte, whatever its encoding", async () => {
    const latin1Comment = Buffer.from("# caf\xe9\nnode_modules/\n", "latin1");
    const logs = Buffer.from("*.log\n");
    const batch = Buffer.concat([
      Buffer.from(`aaa111 blob ${latin1Comment.length}\n`),
      latin1Comment,
      Buffer.from(`\nbbb222 blob ${logs.length}\n`),
      logs,
      Buffer.from("\n"),
    ]).toString("latin1");
    const written: Record<string, number[]> = {};
    const run = vi.fn<Runner["run"]>(async (_command, args, opts) => {
      if (args.includes("ls-files")) return shell("node_modules/\0sub/a.log\0");
      if (args.includes("ls-tree")) return shell("100644 blob aaa111\t.gitignore\x00100644 blob bbb222\tsub/.gitignore\0");
      if (args.includes("cat-file")) return shell(opts.stdoutEncoding === "latin1" ? batch : Buffer.from(batch, "latin1").toString("utf8"));
      if (args.includes("config")) return shell("", { code: 1 });
      if (args.includes("check-ignore")) {
        written.root = [...readFileSync(join(opts.cwd, ".gitignore"))];
        written.sub = [...readFileSync(join(opts.cwd, "sub", ".gitignore"))];
        return shell(opts.stdin ?? "");
      }
      return shell();
    });

    expect(await hiddenFromGit({ run }, gitPath, "/wt", "base1")).toBeNull();
    expect(written.root).toEqual([...latin1Comment]);
    expect(written.sub).toEqual([...logs]);
  });
});

describe("hiddenFromGit over tens of thousands of unignored directories", () => {
  it("judges them in well under a second", async () => {
    const directories = Array.from({ length: 20_000 }, (_, index) => `pkg/module${index}/__pycache__/`);
    const run = vi.fn<Runner["run"]>(async (_command, args) => {
      if (args.includes("ls-files")) return shell(directories.map((path) => `${path}\0`).join(""));
      if (args.includes("config")) return shell("", { code: 1 });
      if (args.includes("check-ignore")) return shell("", { code: 1 });
      return shell();
    });

    const started = performance.now();
    const found = await hiddenFromGit({ run }, gitPath, "/wt", "base1");

    expect(found?.detail).toContain("and 19995 more");
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
