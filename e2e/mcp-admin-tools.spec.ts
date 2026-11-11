import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { McpSession, type ToolCall } from "./mcp";
import { API_TOKEN, E2E_MONGODB_URI, MEMBER_USERNAME, OWNER_ID, OWNER_USERNAME, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-1150. What an MCP client can now set up end to end — a board and who is on it, the board's columns,
 * fields, categories and templates, and the agents a worker runs — driven over the real transport and
 * read back on the screens a person uses.
 */

const OWNER_API_TOKEN = "cp_e2e00011deadbeefdeadbeefdeadbeef";
const SETTINGS = `/projects/${PROJECT_KEY}/settings`;

async function seedOwnerToken() {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    await mongoose.connection.db!.collection("apitokens").insertOne({
      _id: new mongoose.Types.ObjectId(),
      user: OWNER_ID,
      name: "e2e owner (BP-1150)",
      tokenHash: bcrypt.hashSync(OWNER_API_TOKEN, 10),
      prefix: OWNER_API_TOKEN.slice(0, 11),
      allowedProjects: [],
      lastUsedAt: null,
      createdAt: new Date(),
    });
  } finally {
    await mongoose.disconnect();
  }
}

async function connected(request: APIRequestContext, token: string): Promise<McpSession> {
  const session = new McpSession(request, token);
  await session.open();
  return session;
}

function accepted(call: ToolCall) {
  expect(call.status, call.text).toBe(200);
  expect(call.raw.result?.isError ?? false, call.text).toBe(false);
}

function refused(call: ToolCall) {
  expect(call.status, call.text).toBe(200);
  expect(call.raw.result?.isError, call.text).toBe(true);
}

const projectCard = (page: Page, key: string) => page.locator("main").locator(`a[href="/projects/${key}"]`);

test.beforeEach(async () => {
  await seed();
  await seedOwnerToken();
});

test("an admin makes a board over MCP and decides who is on it, and the member's projects page follows", async ({ page, request }) => {
  const admin = await connected(request, API_TOKEN);

  const created = await admin.callTool("create_project", { name: "Web shop", key: "SHOP", description: "From MCP" });
  accepted(created);
  expect(created.parsed).toMatchObject({ key: "SHOP", name: "Web shop" });
  expect(created.parsed.url).toMatch(/\/projects\/SHOP$/);

  await signIn(page, "member");
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
  await expect(projectCard(page, "SHOP")).toHaveCount(0);

  accepted(await admin.callTool("set_member", { project: "SHOP", username: MEMBER_USERNAME, relation: "member" }));

  const roster = await admin.callTool("list_members", { project: "SHOP", relations: true });
  accepted(roster);
  expect(roster.parsed.find((m: { username: string }) => m.username === MEMBER_USERNAME)).toMatchObject({ relation: "member" });

  await page.reload();
  await expect(projectCard(page, "SHOP")).toContainText("Web shop");

  accepted(await admin.callTool("remove_member", { project: "SHOP", username: MEMBER_USERNAME }));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
  await expect(projectCard(page, "SHOP")).toHaveCount(0);
});

test("an owner reshapes the board over MCP, and the settings screens show it", async ({ page, request }) => {
  const owner = await connected(request, OWNER_API_TOKEN);

  accepted(await owner.callTool("remove_column", { project: PROJECT_KEY, column: "Ready to Test" }));
  accepted(await owner.callTool("update_column", { project: PROJECT_KEY, column: "planned", color: "#123456" }));
  const reordered = await owner.callTool("reorder_columns", {
    project: PROJECT_KEY,
    columns: ["todo", "planned", "in_progress", "in_review", "needs_human_review", "done"],
  });
  accepted(reordered);
  expect(reordered.parsed.columns.map((c: { id: string }) => c.id)).toEqual([
    "todo",
    "planned",
    "in_progress",
    "in_review",
    "needs_human_review",
    "done",
  ]);

  accepted(await owner.callTool("add_custom_field", { project: PROJECT_KEY, name: "Size", fieldType: "dropdown", options: ["S", "L"] }));
  accepted(await owner.callTool("update_custom_field", { project: PROJECT_KEY, field: "Size", name: "T-shirt" }));
  accepted(await owner.callTool("remove_field_option", { project: PROJECT_KEY, field: "T-shirt", option: "L" }));
  accepted(await owner.callTool("update_category", { project: PROJECT_KEY, category: "idea", name: "spike" }));
  accepted(await owner.callTool("save_template", { project: PROJECT_KEY, name: "Incident", title: "Incident: ", category: "bug" }));

  await signIn(page, "owner");

  await test.step("the board's columns are in the new order, without the removed one", async () => {
    await page.goto(`${SETTINGS}?section=board`);
    await expect(page.getByRole("heading", { name: "Board", exact: true })).toBeVisible();
    const labels = page.getByLabel("Column name");
    await expect(labels).toHaveCount(6);
    expect(await labels.evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value))).toEqual([
      "To Do",
      "Planned",
      "In Progress",
      "In Review",
      "Needs Human Review",
      "Done",
    ]);
  });

  await test.step("the field, its option, the category and the template read as they were set", async () => {
    await page.goto(`${SETTINGS}?section=fields`);
    await expect(page.getByRole("heading", { name: "Task fields", exact: true })).toBeVisible();
    await expect(page.locator('span:text-is("T-shirt")')).toBeVisible();
    await expect(page.getByText("Choice · 1 option")).toBeVisible();
    const categories = await page.getByLabel("Category name").evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
    expect(categories).toContain("spike");
    expect(categories).not.toContain("idea");
    const templates = await page.getByLabel("Template name").evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
    expect(templates).toContain("Incident");
  });

  await test.step("what the owner may not do is refused, and nothing changes", async () => {
    refused(await owner.callTool("remove_column", { project: PROJECT_KEY, column: "done" }));
    refused(await owner.callTool("delete_custom_field", { project: PROJECT_KEY, field: "T-shirt", confirmName: "Size" }));

    await page.goto(`${SETTINGS}?section=board`);
    await expect(page.getByLabel("Column name")).toHaveCount(6);
    await expect(page.getByLabel("Column name").last()).toHaveValue("Done");
    await page.goto(`${SETTINGS}?section=fields`);
    await expect(page.locator('span:text-is("T-shirt")')).toBeVisible();
  });
});

test("an admin authors a step and composes an agent over MCP, and the Agents page lists both", async ({ page, request }) => {
  const admin = await connected(request, API_TOKEN);

  const step = await admin.callTool("create_agent_block", {
    kind: "step",
    name: "Tidy imports",
    prompt: "List the imports of every file that would need sorting.",
    capability: "read-only",
  });
  accepted(step);
  const key: string = step.parsed.key;

  const agent = await admin.callTool("create_agent", {
    name: "Tidy and ship",
    project: PROJECT_KEY,
    composition: { analysis: [key] },
  });
  accepted(agent);
  expect(agent.parsed.composition.analysis).toEqual([{ key }]);

  accepted(await admin.callTool("update_project", { project: PROJECT_KEY, defaultAgent: "Tidy and ship" }));

  await signIn(page, "admin");
  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Tidy and ship/ })).toBeVisible();
  await page.getByRole("tab", { name: "Steps" }).click();
  await expect(page.getByRole("button", { name: "Tidy imports", exact: true })).toBeVisible();

  await test.step("a block an agent still names cannot be deleted", async () => {
    refused(await admin.callTool("delete_agent_block", { block: key }));
  });
});

test("the two routes opened to a connection answer it instead of asking for a browser", async ({ request }) => {
  const admin = await connected(request, API_TOKEN);

  accepted(await admin.callTool("list_my_machines", {}));

  // A board with the PM off, so the review is refused by the board's own rule rather than started into the next test,
  // asked by an owner through their grant rather than by an instance admin
  accepted(await admin.callTool("create_project", { name: "Quiet board", key: "QUIET" }));
  accepted(await admin.callTool("set_member", { project: "QUIET", username: OWNER_USERNAME, relation: "owner" }));
  const owner = await connected(request, OWNER_API_TOKEN);
  const review = await owner.callTool("run_pm_review", { project: "QUIET" });
  refused(review);
  expect(review.text).toMatch(/PM agent is not enabled for this project/);
});
