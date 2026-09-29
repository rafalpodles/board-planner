import { isAbsolute } from "node:path";

export type ResolvedTool = "git" | "gh" | "claude" | "npm";

export function unresolvedToolReason(tool: ResolvedTool): string {
  return `no absolute ${tool} path was resolved — refusing to run ${tool} by name on PATH`;
}

/**
 * The one decision every spawn of a tool preflight resolves makes when it has no path: refuse.
 * BP-641 made it for git; BP-733 for gh, which carries the pinned account's token, and for the
 * `claude` and `npm` that `sandbox-exec` would otherwise look up by name on the PATH this process
 * assembled from preflight's own findings — anything earlier on it would silently become them.
 *
 * Absolute rather than merely non-empty: preflight only ever resolves one, so a bare name here is
 * a caller that skipped it.
 */
export function requireToolPath(tool: ResolvedTool, path: string): string {
  if (!isAbsolute(path)) throw new Error(unresolvedToolReason(tool));
  return path;
}
