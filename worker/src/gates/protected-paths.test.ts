import { describe, it, expect } from "vitest";
import { protectedPathsGate, PROTECTED_PATHS_BRIEF } from "./protected-paths.js";
import { DiffStats, GateContext } from "../types.js";

function context(changedFiles: string[], symlinks: DiffStats["symlinks"] = []): GateContext {
  return { diff: { changedFiles, symlinks } } as GateContext;
}

const gate = protectedPathsGate();

describe("a committed symlink that leaves the checkout", () => {
  const gate = protectedPathsGate();

  it("is refused, and the refusal says where it points", async () => {
    const verdict = await gate.run(
      context(["src/deep"], [{ path: "src/deep", target: "/Users/rpo/Documents" }])
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("src/deep");
    expect(verdict.reason).toContain("/Users/rpo/Documents");
  });

  it("is refused when it climbs out with .. rather than naming an absolute path", async () => {
    const verdict = await gate.run(
      context(["src/deep"], [{ path: "src/deep", target: "../../elsewhere" }])
    );

    expect(verdict.ok).toBe(false);
  });

  it("is refused when it points into .git, which is inside the checkout but not safe", async () => {
    const verdict = await gate.run(
      context(
        ["hooks", "sub/cfg"],
        [
          { path: "hooks", target: ".git/hooks" },
          { path: "sub/cfg", target: "../.git/config" },
        ]
      )
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("hooks");
    expect(verdict.reason).toContain("sub/cfg");
  });

  it("passes an ordinary one-line file added at exactly the same path", async () => {
    expect((await gate.run(context(["src/deep"]))).ok).toBe(true);
  });

  it("passes a symlink that stays inside the tree, including one that leaves its own directory", async () => {
    const verdict = await gate.run(
      context(
        ["docs/readme", "src/local"],
        [
          { path: "docs/readme", target: "../README.md" },
          { path: "src/local", target: "./other.ts" },
        ]
      )
    );

    expect(verdict.ok).toBe(true);
  });
});

describe("protectedPathsGate", () => {
  it("passes an ordinary change", async () => {
    const verdict = await gate.run(context(["src/lib/slug.ts", "src/lib/slug.test.ts"]));

    expect(verdict.ok).toBe(true);
  });

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

  it.each(["scripts/build.js", "scripts/nested/deploy.sh", "tools/scripts/thing.ts"])(
    "refuses %s",
    async (file) => {
      expect((await gate.run(context([file]))).ok).toBe(false);
    }
  );

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

  it("matches a manifest at any depth, not only at the repository root", async () => {
    expect((await gate.run(context(["worker/package.json"]))).ok).toBe(false);
    expect((await gate.run(context(["services/api/pyproject.toml"]))).ok).toBe(false);
  });

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

describe("what the agent is told matches what the gate refuses", () => {
  const refusedExamples = [
    "package.json",
    "pnpm-lock.yaml",
    "vitest.config.ts",
    "scripts/build.js",
    ".github/workflows/ci.yml",
    ".husky/pre-commit",
    "CLAUDE.md",
    ".mcp.json",
    "Dockerfile",
    "docker-compose.yml",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
  ];

  it("warns about every family the gate actually refuses", async () => {
    const brief = PROTECTED_PATHS_BRIEF.toLowerCase();

    for (const path of refusedExamples) {
      const lower = path.toLowerCase();
      const filename = lower.split("/").pop()!;
      const directory = lower.includes("/") ? `${lower.split("/")[0]}/` : "";
      const named =
        brief.includes(lower) ||
        brief.includes(filename) ||
        brief.includes(filename.split(".")[0]) ||
        (!!directory && brief.includes(directory));
      expect(named, `the brief never mentions ${path}`).toBe(true);
    }
  });

  it("tells the agent what to do instead, since a rule with no alternative is one it will break", () => {
    expect(PROTECTED_PATHS_BRIEF).toMatch(/blocked/);
  });
});
