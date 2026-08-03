import { describe, it, expect } from "vitest";
import { protectedPathsGate } from "./protected-paths.js";
import { GateContext } from "../types.js";

function context(changedFiles: string[]): GateContext {
  return { diff: { changedFiles } } as GateContext;
}

const gate = protectedPathsGate();

describe("protectedPathsGate", () => {
  it("passes an ordinary change", async () => {
    const verdict = await gate.run(context(["src/lib/slug.ts", "src/lib/slug.test.ts"]));

    expect(verdict.ok).toBe(true);
  });

  // The exploit this gate exists for: a postinstall script runs during the build gate, which is
  // several steps before the reviewer ever sees the diff
  it("refuses a package.json change, which the build gate would execute", async () => {
    const verdict = await gate.run(context(["package.json", "src/a.test.ts"]));

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/package\.json/);
    expect(verdict.reason).toMatch(/before any reviewer/);
  });

  it.each([
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    ".npmrc",
    ".yarnrc.yml",
    "binding.gyp",
    ".husky/pre-commit",
    ".git/hooks/pre-push",
    ".github/workflows/ci.yml",
    "packages/api/package.json",
    "nested/dir/.npmrc",
  ])("refuses %s", async (file) => {
    expect((await gate.run(context([file]))).ok).toBe(false);
  });

  it.each([
    "CLAUDE.md",
    "CLAUDE.local.md",
    "AGENTS.md",
    ".mcp.json",
    ".claude/settings.json",
    "sub/.claude/agents/x.md",
  ])("refuses the agent's own instructions: %s", async (file) => {
    expect((await gate.run(context([file]))).ok).toBe(false);
  });

  it("does not refuse a file that merely mentions a protected name", async () => {
    const verdict = await gate.run(
      context(["src/read-package-json.ts", "docs/package.json.md", "src/husky-helper.ts"])
    );

    expect(verdict.ok).toBe(true);
  });

  it("names every offending file, so a human knows what to look at", async () => {
    const verdict = await gate.run(context(["package.json", "CLAUDE.md", "src/ok.ts"]));

    expect(verdict.reason).toMatch(/package\.json/);
    expect(verdict.reason).toMatch(/CLAUDE\.md/);
    expect(verdict.reason).not.toMatch(/src\/ok\.ts/);
  });
});
