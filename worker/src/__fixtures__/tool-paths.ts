import { execFileSync } from "node:child_process";

// The integration suites drive the real binaries, and production only ever hands a spawn an
// absolute path, so they resolve one the way preflight does rather than passing the bare name.
export function installedToolPath(tool: "git" | "gh" | "npm" | "claude"): string {
  return execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
}

// What a stubbed runner is handed: the shape preflight resolves, never the bare name.
export const CLAUDE_PATH = "/opt/homebrew/bin/claude";
export const NPM_PATH = "/opt/homebrew/bin/npm";
export const GH_PATH = "/opt/homebrew/bin/gh";
