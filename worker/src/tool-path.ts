import { isAbsolute } from "node:path";

export type ResolvedTool = "git" | "gh" | "claude" | "npm";

export function unresolvedToolReason(tool: ResolvedTool): string {
  return `no absolute ${tool} path was resolved — refusing to run ${tool} by name on PATH`;
}

// Refuse rather than fall back to the name: anything earlier on the PATH this process assembled
// would silently become the tool (BP-641, BP-733).
export function requireToolPath(tool: ResolvedTool, path: string): string {
  if (!isAbsolute(path)) throw new Error(unresolvedToolReason(tool));
  return path;
}
