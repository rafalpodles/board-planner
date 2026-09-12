import { describe, it, expect } from "vitest";
import {
  isWorkflowPath,
  protectedPathsGate,
  PROTECTED_PATHS_BRIEF,
  workflowPaths,
} from "./protected-paths.js";
import { DiffStats, GateContext } from "../types.js";

function context(changedFiles: string[], symlinks: DiffStats["symlinks"] = []): GateContext {
  return { diff: { changedFiles, symlinks } } as GateContext;
}

const gate = protectedPathsGate();

/**
 * BP-509. Every rule this gate applies is about a path, and `--numstat` renders a symlink as one
 * added line in a file of that name — measured, `deep -> /etc/passwd` and a one-line text file are
 * the same three fields. So the gate could not see that a change had added a door out of the tree.
 */
describe("a committed symlink that leaves the checkout", () => {
  const gate = protectedPathsGate();

  it("is refused, and the refusal says where it points", async () => {
    const verdict = await gate.run(
      context(["src/deep"], [{ path: "src/deep", target: "/Users/owner/Documents" }])
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("src/deep");
    expect(verdict.reason).toContain("/Users/owner/Documents");
  });

  it("is refused when it climbs out with .. rather than naming an absolute path", async () => {
    const verdict = await gate.run(
      context(["src/deep"], [{ path: "src/deep", target: "../../elsewhere" }])
    );

    expect(verdict.ok).toBe(false);
  });

  // `.git` is inside the checkout and is the one directory in it that no gate can see into
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

  /**
   * The controls, and without them "detects symlinks" and "refuses one-line files" would be
   * indistinguishable — which is the whole reason this was invisible.
   */
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

  /**
   * BP-381. `.gitattributes` runs nothing itself — it decides what git SHOWS. `diff.<driver>
   * .textconv` and `filter.<name>.smudge` are selected per path by an attribute, so an agent that
   * adds `package.json -diff` leaves the gate firing on the path exactly as before while the
   * patch a human is handed reads `Binary files … differ`. The attribute is the half that lives
   * in the tree, and it was invisible to every pattern here.
   */
  it.each([".gitattributes", "src/.gitattributes", ".gitmodules"])(
    "refuses %s, which decides what a reviewer is shown",
    async (file) => {
      expect((await gate.run(context([file]))).ok).toBe(false);
    }
  );

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

// BP-380. The gate's patterns and the sentence the agent is given are two descriptions of one
// rule. Two descriptions drift, and the way this one would drift is silent: a family added to the
// patterns and not to the brief means an agent confidently editing a file that will be refused —
// which is the failure this whole thing exists to stop, reintroduced by a rename.
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
    ".gitattributes",
    ".gitmodules",
    ".github/actions/setup/action.yml",
  ];

  it("warns about every family the gate actually refuses", async () => {
    const brief = PROTECTED_PATHS_BRIEF.toLowerCase();

    for (const path of refusedExamples) {
      // the gate refuses it...
      // awaited inside the loop on purpose: the failure message has to name the path
      // ...and the agent was told the name of the thing it is
      // A family is named either by a filename or by the directory it lives in — `.husky/` covers
      // every hook inside it, and the brief says so rather than listing them
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

/**
 * BP-381. Its own predicate rather than another clause in `isProtectedPath`, because these are the
 * one family a person may not accept through the decision panel — not because they are the line
 * between "executes" and "does not" (almost everything on the list executes), but because for a
 * push event GitHub runs the workflow from the pushed ref, so accepting one runs the agent's own
 * version of CI.
 */
describe("the files that decide what CI itself does", () => {
  it.each([
    ".github/workflows/ci.yml",
    ".github/workflows/deploy.yaml",
    // A local composite action is executed by a workflow and matches none of the three patterns
    // the gate already had
    ".github/actions/setup/action.yml",
    ".github/actions/deep/nested/action.yaml",
    // The whole directory, not the manifest: a composite action's manifest names an implementation
    // beside it, and replacing that is what actually changes what CI does
    ".github/actions/setup/index.js",
    ".github/actions/setup/run.sh",
  ])("names %s", (file) => {
    expect(isWorkflowPath(file)).toBe(true);
  });

  it.each([
    ".github/dependabot.yml",
    ".github/ISSUE_TEMPLATE/bug.yml",
    "package.json",
    "src/workflows/ci.yml",
    ".github/workflows/README.md",
  ])("leaves %s to the rules above", (file) => {
    expect(isWorkflowPath(file)).toBe(false);
  });

  /**
   * This predicate narrows what may be ACCEPTED and never widens what the gate refuses — so every
   * family it names has to be refused by the gate as well. A composite action was not: none of the
   * three path patterns covered `.github/actions/`, so a change touching only one tripped nothing,
   * was pushed, and ran in Actions with the repository's secrets by the ordinary route.
   */
  it.each([".github/workflows/ci.yml", ".github/actions/setup/action.yml"])(
    "is refused by the gate as well: %s",
    async (file) => {
      expect((await protectedPathsGate().run(context([file]))).ok).toBe(false);
    }
  );

  it("lists the offending files, so a refusal can name them", () => {
    expect(workflowPaths(["src/a.ts", ".github/workflows/ci.yml"])).toEqual([
      ".github/workflows/ci.yml",
    ]);
  });
});
