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

  // BP-333. The build gate runs `npm run build`, and in this repository that is `next build`, which
  // imports next.config.ts — so the gate checking the change was executing a file the change could
  // rewrite. --ignore-scripts closed lifecycle hooks; it does nothing about this.
  it.each([
    "next.config.ts",
    "next.config.mjs",
    "vite.config.js",
    "vitest.config.ts",
    "webpack.config.js",
    "jest.config.cjs",
    "playwright.config.ts",
    "tailwind.config.ts",
    "babel.config.js",
    ".babelrc",
    "Makefile",
  ])("refuses %s, which a build or test script loads and runs", async (file) => {
    const verdict = await gate.run(context([file, "src/a.test.ts"]));

    expect(verdict.ok).toBe(false);
  });

  // A package.json script pointing at scripts/build.js means editing that file is execution without
  // touching package.json, which is protected
  it.each(["scripts/build.js", "scripts/nested/deploy.sh", "tools/scripts/thing.ts"])(
    "refuses %s",
    async (file) => {
      expect((await gate.run(context([file]))).ok).toBe(false);
    }
  );

  // BP-333, the other half: in a non-JS repository the build gate fails on `npm ci` before reading
  // anything, so nothing here is executed locally. These files decide what runs *after* the change
  // lands — the same hazard .github/workflows carries, and with autoMerge on there is no human
  // between the change and the target's own CI.
  it.each([
    "pyproject.toml",
    "requirements.txt",
    "requirements-dev.txt",
    "setup.py",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Gemfile",
    "Rakefile",
    "Cargo.toml",
    "go.mod",
    "composer.json",
    "mix.exs",
    "pubspec.yaml",
    "Dockerfile",
    "docker-compose.yml",
    ".gitlab-ci.yml",
    "Jenkinsfile",
  ])("refuses %s, which decides what runs after the change lands", async (file) => {
    const verdict = await gate.run(context([file]));

    expect(verdict.ok).toBe(false);
  });

  // Not anchored to the root: this repository has three manifests, and worker/package.json is the
  // one that runs the unattended agent
  it("matches a manifest at any depth, not only at the repository root", async () => {
    expect((await gate.run(context(["worker/package.json"]))).ok).toBe(false);
    expect((await gate.run(context(["services/api/pyproject.toml"]))).ok).toBe(false);
  });

  // The gate has to stay usable: a repo full of ordinary source and docs must still pass
  it.each([
    "src/lib/slug.ts",
    "docs/guide.md",
    "src/app/page.tsx",
    "README.md",
    "src/styles/globals.css",
    "public/logo.svg",
  ])("still passes %s", async (file) => {
    expect((await gate.run(context([file]))).ok).toBe(true);
  });
});
