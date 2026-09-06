import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
