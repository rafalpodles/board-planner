/**
 * BP-711: the built stdio MCP server (`mcp-server/`), spawned as its own process against the e2e
 * app and spoken to over stdio by the SDK's client. Every other MCP test drives the app's HTTP
 * endpoint or the tool registrations in-process; this is the only one that runs the package users
 * install. Each tool call is checked against the database, not against the tool's reply.
 *
 * Decision (BP-711): mcp-server and the worker get a live path each, in jobs of their own outside
 * the six e2e groups; the menubar stays on its Swift unit tests and the contract tests, because
 * driving a UI app against a server needs macOS UI automation and the worker smoke already covers
 * the protocol the menubar wraps.
 */
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import mongoose from "mongoose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BASE_URL } from "../../playwright.config";
import { API_TOKEN, E2E_MONGODB_URI, HELD_TASK_TITLE, PROJECT_ID, PROJECT_KEY, seed, storedTask } from "../seed";

const MCP_SERVER_DIR = join(__dirname, "..", "..", "mcp-server");

type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean };

function textOf(result: ToolResult): string {
  return (result.content ?? []).map((part) => part.text ?? "").join("\n");
}

async function storedComments(taskId: unknown): Promise<string[]> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    const rows = await mongoose.connection.db!.collection("comments").find({ task: taskId }).toArray();
    return rows.map((row) => String(row.body));
  } finally {
    await mongoose.disconnect();
  }
}

let client: Client;

test.beforeAll(() => {
  execFileSync("npm", ["run", "build"], { cwd: MCP_SERVER_DIR, stdio: "pipe" });
});

test.beforeEach(async () => {
  await seed();
  client = new Client({ name: "bp-711-smoke", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(MCP_SERVER_DIR, "dist", "index.js")],
      env: { BOARDPLANNER_URL: BASE_URL, BOARDPLANNER_TOKEN: API_TOKEN, PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    })
  );
});

test.afterEach(async () => {
  await client?.close();
});

test("the stdio server lists, creates, edits, moves and comments on a task in the running app", async () => {
  expect(client.getServerVersion()?.name).toBe("boardplanner");

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  for (const name of ["list_tasks", "create_task", "update_task", "change_task_status", "add_comment"]) {
    expect(names).toContain(name);
  }

  const listed = (await client.callTool({ name: "list_tasks", arguments: { project: PROJECT_KEY } })) as ToolResult;
  expect(listed.isError, textOf(listed)).toBeFalsy();
  const listedTitles = (JSON.parse(textOf(listed)) as { title: string }[]).map((task) => task.title);
  expect(listedTitles).toContain(HELD_TASK_TITLE);

  const title = "Raised over stdio";
  const created = (await client.callTool({
    name: "create_task",
    arguments: { project: PROJECT_KEY, title, status: "todo", priority: "low" },
  })) as ToolResult;
  expect(created.isError, textOf(created)).toBeFalsy();
  const taskNumber = (JSON.parse(textOf(created)) as { taskNumber: number }).taskNumber;
  expect(taskNumber, textOf(created)).toBeGreaterThan(0);
  const taskKey = `${PROJECT_KEY}-${taskNumber}`;

  const afterCreate = await storedTask(taskNumber);
  expect(afterCreate).toMatchObject({ title, status: "todo", priority: "low" });
  expect(String(afterCreate.project)).toBe(String(PROJECT_ID));

  const updated = (await client.callTool({
    name: "update_task",
    arguments: { taskKey, title: `${title}, then renamed`, priority: "high" },
  })) as ToolResult;
  expect(updated.isError, textOf(updated)).toBeFalsy();
  expect(await storedTask(taskNumber)).toMatchObject({ title: `${title}, then renamed`, priority: "high" });

  const moved = (await client.callTool({
    name: "change_task_status",
    arguments: { taskKey, status: "in_progress" },
  })) as ToolResult;
  expect(moved.isError, textOf(moved)).toBeFalsy();
  expect((await storedTask(taskNumber)).status).toBe("in_progress");

  const body = "Commented from the stdio smoke";
  const commented = (await client.callTool({ name: "add_comment", arguments: { taskKey, body } })) as ToolResult;
  expect(commented.isError, textOf(commented)).toBeFalsy();
  expect(await storedComments(afterCreate._id)).toEqual([body]);
});
