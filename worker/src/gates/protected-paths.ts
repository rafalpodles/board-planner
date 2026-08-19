import { Gate } from "../types.js";

// The CLI loads these from its cwd as instructions and configuration, above any "untrusted data"
// boundary a prompt can draw
export const AGENT_INSTRUCTION_FILE =
  /(^|\/)(CLAUDE(\.local)?\.md|AGENTS(\.local)?\.md|\.mcp\.json)$|(^|\/)\.claude\//i;

// Files whose contents a later gate executes. package.json is the sharp one: the build gate runs
// npm on the worktree, so a lifecycle script added here would run before any reviewer sees it.
//
// The build gate passes --ignore-scripts to `npm ci`, which closes lifecycle hooks — but it then
// runs `npm run build`, and whatever that resolves to is executed in full. In this repository that
// is `next build`, which imports next.config.ts: arbitrary code, run by the gate whose job is to
// check the change (BP-333). The same holds for every bundler and test-runner config a build or
// test script loads, and for scripts/, because a package.json script pointing at scripts/build.js
// means editing that file is code execution without touching package.json at all.
export const EXECUTABLE_CONFIG_FILE =
  /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|\.npmrc|\.yarnrc(\.yml)?|binding\.gyp)$|(^|\/)(next|vite|vitest|webpack|rollup|jest|babel|astro|svelte|nuxt|tailwind|postcss|playwright|esbuild|metro|remix|gatsby)\.config\.[cm]?[jt]sx?$|(^|\/)(\.babelrc(\.[cm]?js(on)?)?|Makefile|CMakeLists\.txt)$|(^|\/)(\.husky|\.git\/hooks|\.github\/workflows|scripts)\//i;

// Manifests that decide what runs *after* this change lands, in a repository this worker's gates
// cannot execute at all. A non-JS repo fails the build gate on `npm ci` before reading anything, so
// nothing here is executed locally — which is exactly why it was invisible to the list above and
// why leaving it out was worse than not supporting those repos: the gates report as having run.
//
// The hazard is the same one .github/workflows carries. With autoMerge on, a change to a build
// backend, a task runner or a dependency pin reaches the default branch with no human in the loop,
// and the target's own CI executes it there.
//
// Matched at any depth, not only at the repository root: this repository alone has three manifests
// (root, worker/, mcp-server/), and an agent editing worker/package.json is doing the same thing as
// one editing the root — so anchoring to the root would protect the least interesting one.
export const BUILD_MANIFEST_FILE =
  /(^|\/)(pyproject\.toml|poetry\.lock|Pipfile(\.lock)?|requirements[^/]*\.txt|setup\.(py|cfg)|tox\.ini|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|Gemfile(\.lock)?|Rakefile|Cargo\.(toml|lock)|go\.(mod|sum)|composer\.(json|lock)|mix\.exs|pubspec\.yaml|Dockerfile|docker-compose\.ya?ml|\.gitlab-ci\.ya?ml|Jenkinsfile)$/i;

/** Every file this gate treats as deciding what gets executed, here or after the change lands. */
export function isProtectedPath(file: string): boolean {
  return (
    AGENT_INSTRUCTION_FILE.test(file) ||
    EXECUTABLE_CONFIG_FILE.test(file) ||
    BUILD_MANIFEST_FILE.test(file)
  );
}

export function protectedPaths(files: string[]): string[] {
  return files.filter(isProtectedPath);
}

export function protectedPathsGate(): Gate {
  return {
    name: "protected-paths",
    async run({ diff }) {
      const hits = protectedPaths(diff.changedFiles);
      if (hits.length === 0) return { ok: true, reason: "" };

      return {
        ok: false,
        reason: `the change touches files that later steps execute or load as their own instructions (${hits.join(", ")}). A lifecycle script or an agent instruction added here would run before any reviewer could read it, so a human has to review this — not an agent, and not a gate running inside the same tree.`,
      };
    },
  };
}
