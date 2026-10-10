import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPlannerTools } from "./tools";
import { SERVER_INSTRUCTIONS } from "./instructions";
import { COLUMN_ROLES, DEFAULT_PROJECT_COLUMNS, DEPENDENCY_TYPES } from "@/types";

const SKILL_DIR = path.join(process.cwd(), "plugins/board-planner/skills/board-planner");

function registeredToolNames(): Set<string> {
  const names = new Set<string>();
  const server = { registerTool: (name: string) => names.add(name) } as unknown as McpServer;
  registerPlannerTools(server);
  return names;
}

function skillFiles(): { file: string; text: string }[] {
  const files = ["SKILL.md", ...readdirSync(path.join(SKILL_DIR, "references")).map((f) => `references/${f}`)];
  return files.map((file) => ({ file, text: readFileSync(path.join(SKILL_DIR, file), "utf8") }));
}

const SNAKE_CASE = /\b[a-z]+(?:_[a-z]+)+\b/g;
const KNOWN_VALUES = new Set<string>([...DEFAULT_PROJECT_COLUMNS.map((c) => c.id), ...DEPENDENCY_TYPES]);

describe("the server's instructions", () => {
  it("name only tools the server registers", () => {
    const tools = registeredToolNames();
    const named = new Set(SERVER_INSTRUCTIONS.match(SNAKE_CASE));
    expect(named.size).toBeGreaterThan(3);
    expect([...named].filter((name) => !tools.has(name))).toEqual([]);
  });

  it("list every column role and no other", () => {
    const listed = SERVER_INSTRUCTIONS.match(/role \(([^)]+)\)/)?.[1].split(", ");
    expect(listed).toEqual([...COLUMN_ROLES]);
  });
});

describe("the board-planner skill", () => {
  it("names only tools the server registers, besides default column ids and link types", () => {
    const tools = registeredToolNames();
    const unknown = skillFiles().flatMap(({ file, text }) =>
      [...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)]
        .map((m) => m[1])
        .filter((name) => !tools.has(name) && !KNOWN_VALUES.has(name))
        .map((name) => `${file}: ${name}`),
    );
    expect(unknown).toEqual([]);
  });

  it("lists every column role and no other", () => {
    const columns = skillFiles().find((f) => f.file === "references/columns.md")!.text;
    const roles = [...columns.matchAll(/^\| `([a-z]+)` \| [A-Z][^|]* \| [A-Z]/gm)].map((m) => m[1]);
    expect(roles).toEqual([...COLUMN_ROLES]);
  });

  it("shows the default columns as a new board gets them", () => {
    const columns = skillFiles().find((f) => f.file === "references/columns.md")!.text;
    const rows = [...columns.matchAll(/^\| `([a-z_]+)` \| ([^|]+) \| ([a-z]+) \|$/gm)].map((m) => ({
      id: m[1],
      label: m[2].trim(),
      role: m[3],
    }));
    expect(rows).toEqual(DEFAULT_PROJECT_COLUMNS.map(({ id, label, role }) => ({ id, label, role })));
  });

  it("is about any board, not this repository's", () => {
    const local = skillFiles().filter(({ text }) => /\bBP-\d|bp-task|board-planner-site|Notion|rafal/.test(text));
    expect(local.map((f) => f.file)).toEqual([]);
  });
});
