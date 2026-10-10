import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { registerPlannerTools } from "./tools";
import { BATCH_LIMIT } from "./batch";
import { SERVER_INSTRUCTIONS } from "./instructions";
import { COLUMN_ROLES, DEFAULT_PROJECT_COLUMNS, DEPENDENCY_TYPES } from "@/types";

const SKILL_DIR = path.join(process.cwd(), "plugins/board-planner/skills/board-planner");

function registeredTools(): Map<string, string[]> {
  const tools = new Map<string, string[]>();
  const server = {
    registerTool: (name: string, config: { inputSchema?: z.ZodObject<z.ZodRawShape> }) =>
      tools.set(name, Object.keys(config.inputSchema?.shape ?? {})),
  } as unknown as McpServer;
  registerPlannerTools(server);
  return tools;
}

function registeredToolNames(): Set<string> {
  return new Set(registeredTools().keys());
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

  it.each([
    ["list_tasks", ["status", "assignee", "priority", "category", "search", "sprint", "parent", "hasChildren", "fields", "dueBefore", "dueAfter", "updatedSince", "archived", "blocked"]],
    ["create_task", ["status", "acceptanceCriteria", "minimal", "fields"]],
    ["update_task", ["assignee", "agent", "acceptanceCriteria", "fields", "minimal"]],
    ["change_task_status", ["status", "minimal"]],
    ["create_tasks", []],
    ["update_tasks", []],
    ["whoami", []],
  ])("%s takes every argument the skill names", (tool, args) => {
    expect(registeredTools().get(tool)).toEqual(expect.arrayContaining(args));
  });

  it("states the batch limit the server enforces", () => {
    const tools = skillFiles().find((f) => f.file === "references/tools.md")!.text;
    expect(tools).toContain(`take up to ${BATCH_LIMIT} items in one call`);
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
