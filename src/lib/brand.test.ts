import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME } from "./brand";

/**
 * "Claude" is somebody else's trademark, which is what forced the rename — so the old name
 * coming back is not a style slip, it is the problem returning. A grep is the only thing that
 * notices: a hardcoded wordmark renders perfectly and no test about behaviour would fail.
 *
 * The allowlist below is the deliberate exceptions, each an identifier something outside this
 * repository already keys on. Adding to it should feel like a decision.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const OLD_NAME = /claude ?-? ?planner/i;

/** Identifiers, not branding: renaming any of these breaks a client that is already configured. */
const KEEPS_THE_OLD_NAME: Record<string, string> = {
  "app/api/mcp/route.ts": "MCP client configs key on serverInfo.name",
  "lib/board-refresh.ts": "event and channel names shared between already-open tabs",
  "lib/pm/mcp-client.ts": "clientInfo.name sent to remote MCP servers",
  "lib/pm/mcp-oauth.ts": "client_name registered with remote OAuth servers",
  "lib/repo-match.test.ts": "GitHub URLs — the repository's real name, not the product's",
  "lib/brand.ts": "explains what the name replaced",
  "lib/brand.test.ts": "this file",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe("the old brand name", () => {
  it("survives only where something outside this repository depends on it", () => {
    const offenders = sourceFiles(SRC)
      .map((file) => ({ file: relative(SRC, file), text: readFileSync(file, "utf8") }))
      .filter(({ file, text }) => OLD_NAME.test(text) && !(file in KEEPS_THE_OLD_NAME))
      .map(({ file }) => file);

    expect(offenders, `use APP_NAME from @/lib/brand, or add the file to KEEPS_THE_OLD_NAME with a reason`).toEqual([]);
  });

  it("is not what the product calls itself", () => {
    expect(OLD_NAME.test(APP_NAME)).toBe(false);
  });
});
