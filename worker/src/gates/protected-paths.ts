import { Gate } from "../types.js";

// The CLI loads these from its cwd as instructions and configuration, above any "untrusted data"
// boundary a prompt can draw
export const AGENT_INSTRUCTION_FILE =
  /(^|\/)(CLAUDE(\.local)?\.md|AGENTS(\.local)?\.md|\.mcp\.json)$|(^|\/)\.claude\//i;

// Files whose contents a later gate executes. package.json is the sharp one: the build gate runs
// npm on the worktree, so a lifecycle script added here would run before any reviewer sees it
export const EXECUTABLE_CONFIG_FILE =
  /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|\.npmrc|\.yarnrc(\.yml)?|binding\.gyp)$|(^|\/)(\.husky|\.git\/hooks|\.github\/workflows)\//i;

export function protectedPaths(files: string[]): string[] {
  return files.filter(
    (file) => AGENT_INSTRUCTION_FILE.test(file) || EXECUTABLE_CONFIG_FILE.test(file)
  );
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
