import { posix } from "node:path";

import { DiffStats, Gate } from "../types.js";

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

export const EXECUTABLE_CONFIG_FILE =
  /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|\.npmrc|\.yarnrc(\.yml)?|binding\.gyp)$|(^|\/)(next|vite|vitest|webpack|rollup|jest|babel|astro|svelte|nuxt|tailwind|postcss|playwright|esbuild|metro|remix|gatsby)\.config\.[cm]?[jt]sx?$|(^|\/)(\.babelrc(\.[cm]?js(on)?)?|Makefile|CMakeLists\.txt)$|(^|\/)(\.husky|\.git\/hooks|\.github\/workflows|scripts)\//i;

export const BUILD_MANIFEST_FILE =
  /(^|\/)(pyproject\.toml|poetry\.lock|Pipfile(\.lock)?|requirements[^/]*\.txt|setup\.(py|cfg)|tox\.ini|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|Gemfile(\.lock)?|Rakefile|Cargo\.(toml|lock)|go\.(mod|sum)|composer\.(json|lock)|mix\.exs|pubspec\.yaml|Dockerfile|docker-compose\.ya?ml|\.gitlab-ci\.ya?ml|Jenkinsfile)$/i;

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

export function escapingSymlinks(
  symlinks: DiffStats["symlinks"],
): { path: string; target: string }[] {
  return symlinks.filter(({ path, target }) => {
    if (posix.isAbsolute(target)) return true;
    const resolved = posix.normalize(posix.join(posix.dirname(path), target));
    if (resolved === ".." || resolved.startsWith("../")) return true;
    return resolved === ".git" || resolved.startsWith(".git/");
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
