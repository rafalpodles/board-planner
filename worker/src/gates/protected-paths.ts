import { posix } from "node:path";

import { DiffStats, Gate } from "../types.js";

// The CLI loads these from its cwd as instructions and configuration, above any "untrusted data"
// boundary a prompt can draw
// The same rule in the words the agent gets, and deliberately in this file: a list of patterns the
// gate enforces and a sentence the agent is told are two descriptions of one rule, and two
// descriptions in two files drift. protected-paths.test.ts holds them together.
//
// It exists because the agent never knew. MP-71 was a task ABOUT the Dockerfile, so it edited the
// Dockerfile and lost a full run to a gate whose answer was decided before it started; MP-75 added
// a `test` script so its own tests could run, and lost one the same way. `blocked` was always the
// right answer for those — it just had no way to know it was the answer.
export const PROTECTED_PATHS_BRIEF = [
  "You may not create, edit or delete files that a later step executes or loads as instructions:",
  "package manifests and lockfiles (package.json, package-lock.json, pnpm-lock.yaml, yarn.lock, .npmrc),",
  "build and test tool configs (vite, vitest, next, webpack, jest, babel, playwright, tailwind and the like),",
  "anything under scripts/, .husky/, .github/workflows/ or .claude/,",
  "agent instruction files (CLAUDE.md, AGENTS.md, .mcp.json),",
  "container and CI manifests (Dockerfile, docker-compose.yml, .gitlab-ci.yml, Jenkinsfile),",
  "and the build manifests of other ecosystems (pyproject.toml, Cargo.toml, go.mod, pom.xml, Gemfile and their lockfiles).",
  "If the task cannot be finished without touching one of those, do not touch it: return status 'blocked' naming the file and what you would have changed in it.",
  "A human does that part.",
].join(" ");

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

/**
 * A committed symlink whose target leaves the checkout, with where it goes.
 *
 * `--numstat` renders a symlink as one added line in a file of that name — measured, a
 * `deep -> /etc/passwd` and a one-line text file are the same three fields — so the list of paths
 * this gate reads cannot tell them apart, and every rule above is about paths. What that buys an
 * agent is a door: the run's own worktree, or anything else on the machine, re-attached at a name
 * inside the tree and readable from any step that reads files there, including a reviewer given a
 * checkout precisely so it could not reach them (BP-509).
 *
 * Judged by resolving the target against the link's own directory, not by touching the disk: a
 * relative link that stays inside the tree is ordinary, and `docs/x -> ../README.md` is inside even
 * though it leaves `docs/`.
 */
export function escapingSymlinks(
  symlinks: DiffStats["symlinks"],
): { path: string; target: string }[] {
  return symlinks.filter(({ path, target }) => {
    if (posix.isAbsolute(target)) return true;
    const resolved = posix.normalize(posix.join(posix.dirname(path), target));
    return resolved === ".." || resolved.startsWith("../");
  });
}

export function protectedPathsGate(): Gate {
  return {
    name: "protected-paths",
    async run({ diff }) {
      const escaping = escapingSymlinks(diff.symlinks);
      if (escaping.length > 0) {
        return {
          ok: false,
          reason: `the change adds a symlink pointing out of the checkout (${escaping
            .map(({ path, target }) => `${path} → ${target}`)
            .join(
              ", ",
            )}). Every rule this gate applies is about paths, and a symlink is one path that stands for another — so a later step reading inside the tree would be reading whatever that names. A human has to look at this.`,
        };
      }

      const hits = protectedPaths(diff.changedFiles);
      if (hits.length === 0) return { ok: true, reason: "" };

      return {
        ok: false,
        reason: `the change touches files that later steps execute or load as their own instructions (${hits.join(", ")}). A lifecycle script or an agent instruction added here would run before any reviewer could read it, so a human has to review this — not an agent, and not a gate running inside the same tree.`,
      };
    },
  };
}
