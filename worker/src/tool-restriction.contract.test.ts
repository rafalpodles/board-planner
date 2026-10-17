import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
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

  // Not only the flags that matter most: any claude flag spelt at a call site is an argv built
  // outside the adapter, which is where the two contract tests above cannot see it
  const CLAUDE_FLAGS = [
    "--allowedTools",
    "--tools",
    "--permission-mode",
    "--dangerously-skip-permissions",
    "--mcp-config",
    "--strict-mcp-config",
    "--safe-mode",
    "--append-system-prompt",
    "--json-schema",
    "--model",
    "--fallback-model",
    "--dangerously-bypass-approvals-and-sandbox",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--output-schema",
    "--disable",
  ];

  it.each(CALL_SITES.map((file) => [file, file === "executor.ts" ? "editArgs" : "reviewArgs"]))(
    "%s builds no argv of its own and asks the adapter for %s",
    (file, method) => {
      const text = source(file);
      for (const flag of CLAUDE_FLAGS) expect(text, flag).not.toContain(`"${flag}"`);
      expect(text).toContain(`agent.${method}(`);
    },
  );

  it("gives the reviewer no way to write to the tree it is judging", () => {
    const text = source(ADAPTER);
    const reviewer = text.slice(text.indexOf("reviewArgs(call"));
    const tools = reviewer.slice(reviewer.indexOf('"--tools"'), reviewer.indexOf('"--tools"') + 120);
    expect(tools).toContain("Read Grep Glob");
    expect(tools).not.toMatch(/Edit|Write|Bash/);
  });
});

// Codex has no tool list to restrict, so what keeps its surface small is spelt once, in its adapter
describe("the codex adapter's surface", () => {
  const CODEX = "agents/codex.ts";

  it("runs under our own sandbox and never relies on Codex's", () => {
    const text = source(CODEX);
    expect(text).toContain('"--dangerously-bypass-approvals-and-sandbox"');
    for (const flag of ["--sandbox", "-s", "--full-auto", "--approve-for-me"]) expect(text, flag).not.toContain(`"${flag}"`);
  });

  it("is the only file that spells the flag that turns Codex's own sandbox off", () => {
    const spellers = (readdirSync(join(import.meta.dirname), { recursive: true }) as string[])
      .filter((file) => file.endsWith(".ts") && !file.includes(".test."))
      .filter((file) => source(file).includes("--dangerously-bypass-approvals-and-sandbox"));
    expect(spellers).toEqual([CODEX]);
  });

  it("switches off web search, which runs on the provider's side where no sandbox reaches", () => {
    expect(source(CODEX)).toContain('web_search="disabled"');
  });

  it("starts from no user config and no rules of the operator's", () => {
    const text = source(CODEX);
    expect(text).toContain('"--ignore-user-config"');
    expect(text).toContain('"--ignore-rules"');
  });
});
