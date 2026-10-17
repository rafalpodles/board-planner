import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Measured on 2026-08-15, not assumed: under `--permission-mode bypassPermissions`,
 *
 *   claude -p '…' --permission-mode bypassPermissions --allowedTools "Read Grep Glob"
 *
 * ran Bash anyway. --allowedTools is an allowlist for skipping the permission prompt, and under
 * bypassPermissions nothing prompts. The same command with --tools refused: "narzędzie Bash jest w
 * tej sesji wyłączone (również dla subagentów)".
 *
 * That run also listed the MCP servers from the operator's own config as still available — Jira,
 * Notion, GitHub, Board Planner — which is why --strict-mcp-config is here too. An unattended agent
 * with Board Planner's MCP could move the very task it is running, and no gate reads anything but
 * the diff.
 */
// The argv of the claude CLI is spelt in one place, its adapter; the executor and the review gate
// ask it for an argv and may not build one of their own.
const ADAPTER = "agents/claude.ts";
const CALL_SITES = ["executor.ts", "gates/review.ts"];

function source(file: string): string {
  return readFileSync(join(import.meta.dirname, file), "utf8");
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe("the agent's tool surface", () => {
  it("is restricted with --tools, never with --allowedTools", () => {
    const text = source(ADAPTER);
    expect(text).toContain('"--tools"');
    expect(text).not.toContain('"--allowedTools"');
  });

  // Once for the implementer's argv and once for the reviewer's: one of them losing it is the gap
  it("drops the operator's MCP servers for the implementer and for the reviewer", () => {
    expect(occurrences(source(ADAPTER), '"--strict-mcp-config"')).toBe(2);
  });

  it.each(CALL_SITES)("%s builds no argv of its own", (file) => {
    const text = source(file);
    expect(text).not.toContain('"--tools"');
    expect(text).not.toContain('"--permission-mode"');
    expect(text).toMatch(/agent\.(editArgs|reviewArgs)\(/);
  });

  it("gives the reviewer no way to write to the tree it is judging", () => {
    const text = source(ADAPTER);
    const reviewer = text.slice(text.indexOf("reviewArgs(call"));
    const tools = reviewer.slice(reviewer.indexOf('"--tools"'), reviewer.indexOf('"--tools"') + 120);
    expect(tools).toContain("Read Grep Glob");
    expect(tools).not.toMatch(/Edit|Write|Bash/);
  });
});
