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
const SOURCES = ["executor.ts", "gates/review.ts"];

function source(file: string): string {
  return readFileSync(join(import.meta.dirname, file), "utf8");
}

describe("the agent's tool surface", () => {
  it.each(SOURCES)("%s restricts with --tools, never with --allowedTools", (file) => {
    const text = source(file);
    expect(text).toContain('"--tools"');
    expect(text).not.toContain('"--allowedTools"');
  });

  it.each(SOURCES)("%s drops the operator's MCP servers", (file) => {
    expect(source(file)).toContain('"--strict-mcp-config"');
  });

  it("gives the reviewer no way to write to the tree it is judging", () => {
    const text = source("gates/review.ts");
    const tools = text.slice(text.indexOf('"--tools"'), text.indexOf('"--tools"') + 120);
    expect(tools).not.toMatch(/Edit|Write|Bash/);
  });
});
