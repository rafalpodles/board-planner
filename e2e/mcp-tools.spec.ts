import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { MONGO_PROXY_CONTROL_URL } from "../playwright.config";
import { ADMIN_AUTH, SAME_ORIGIN } from "./api";
import { McpSession, authorize, type ToolCall } from "./mcp";
import {
  ADMIN_USERNAME,
  API_TOKEN,
  FOREIGN_ONLY_AGENT_NAME,
  FOREIGN_SPRINT_ID,
  FOREIGN_SPRINT_NAME,
  HELD_TASK_ID,
  HELD_TASK_KEY,
  HELD_TASK_NUMBER,
  HELD_TASK_TITLE,
  KEPT_TASK_ID,
  KEPT_TASK_KEY,
  KEPT_TASK_TITLE,
  MEMBER_API_TOKEN,
  MEMBER_ID,
  MEMBER_USERNAME,
  PERSONAL_AGENT_NAME,
  PROJECT_AGENT_ID,
  PROJECT_AGENT_NAME,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  RUN_PHASE,
  SECOND_PROJECT_ID,
  SECOND_PROJECT_KEY,
  SECOND_PROJECT_NAME,
  SIBLING_TASK_ID,
  SIBLING_TASK_KEY,
  SIBLING_TASK_NUMBER,
  SOURCE_COLUMN,
  SPARE_COLUMN,
  TARGET_COLUMN,
  WORKER_NAME,
  seed,
  seedAgents,
  seedDemotableAdmin,
  seedForeignAgent,
  seedForeignSprint,
  seedSecondProject,
  storedExecution,
  storedSprint,
  storedTask,
} from "./seed";
import { signIn } from "./session";

const NEXT_TASK_NUMBER = 5;

const boardUrl = `/projects/${PROJECT_KEY}`;
const taskUrl = (taskNumber: number) => `/projects/${PROJECT_KEY}/tasks/${taskNumber}`;

function column(page: Page, columnId: string): Locator {
  return page.getByTestId(`column-${columnId}`);
}

function cardIn(column: Locator, taskNumber: number): Locator {
  return column.locator(`a[href="${taskUrl(taskNumber)}"]`);
}

async function openBoard(page: Page) {
  await signIn(page);
  await page.goto(boardUrl);
  await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
}

async function connected(request: APIRequestContext, token = API_TOKEN): Promise<McpSession> {
  const session = new McpSession(request, token);
  await session.open();
  return session;
}

function accepted(call: ToolCall) {
  expect(call.status, call.text).toBe(200);
  expect(call.raw.result, JSON.stringify(call.raw)).toBeDefined();
  expect(call.raw.result?.isError ?? false, call.text).toBe(false);
}

function refused(call: ToolCall) {
  expect(call.status, call.text).toBe(200);
  expect(call.raw.result?.isError, call.text).toBe(true);
}

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async ({ request }) => {
  await request.post(`${MONGO_PROXY_CONTROL_URL}/restore`);
});

test("create_task lands on the board with everything it named", async ({ page, request }) => {
  const session = await connected(request);

  const created = await session.callTool("create_task", {
    project: PROJECT_KEY,
    title: "Filed over MCP",
    description: "Written by an agent, not a person",
    priority: "high",
    category: "bug",
    status: SPARE_COLUMN.id,
    assignee: MEMBER_USERNAME,
    acceptanceCriteria: "- [ ] the card is on the board\n- [ ] with its checklist",
  });
  accepted(created);
  expect(created.parsed).toMatchObject({
    taskNumber: NEXT_TASK_NUMBER,
    title: "Filed over MCP",
    description: "Written by an agent, not a person",
    priority: "high",
    category: "bug",
    status: SPARE_COLUMN.id,
  });
  expect(created.parsed.assignee.username).toBe(MEMBER_USERNAME);
  expect(created.parsed.assignedBy.username).toBe(ADMIN_USERNAME);
  expect(created.parsed.checklist.map((item: { text: string; done: boolean }) => [item.text, item.done])).toEqual([
    ["the card is on the board", false],
    ["with its checklist", false],
  ]);

  await openBoard(page);
  const card = cardIn(column(page, SPARE_COLUMN.id), NEXT_TASK_NUMBER);
  await expect(card).toBeVisible();
  await expect(card).toContainText("Filed over MCP");
  await expect(page.locator(`[data-column-body] a[href="${taskUrl(NEXT_TASK_NUMBER)}"]`)).toHaveCount(1);

  const readBack = await session.callTool("get_task", { taskKey: `${PROJECT_KEY}-${NEXT_TASK_NUMBER}` });
  expect(readBack.parsed.title).toBe("Filed over MCP");
  expect(readBack.parsed.assignee.username).toBe(MEMBER_USERNAME);
});

test("create_task refuses what the board does not have, and mints no number doing so", async ({
  request,
}) => {
  const session = await connected(request);

  const noSuchCategory = await session.callTool("create_task", {
    project: PROJECT_KEY,
    title: "Wrong category",
    category: "chore",
  });
  refused(noSuchCategory);
  expect(noSuchCategory.text).toContain('Invalid category "chore"');
  expect(noSuchCategory.text).toContain("bug, doc, user-story, idea");

  const noSuchColumn = await session.callTool("create_task", {
    project: PROJECT_KEY,
    title: "Wrong column",
    status: "shipped",
  });
  refused(noSuchColumn);
  expect(noSuchColumn.text).toContain('Invalid status "shipped"');

  const nobody = await session.callTool("create_task", {
    project: PROJECT_KEY,
    title: "Wrong person",
    assignee: "nobody",
  });
  refused(nobody);
  expect(nobody.text).toContain('"nobody" is not someone this board can be assigned to');

  const tooLong = await session.callTool("create_task", {
    project: PROJECT_KEY,
    title: "x".repeat(201),
  });
  refused(tooLong);
  expect(tooLong.text).toContain("at most 200 characters");

  const armed = await session.callTool("create_task", {
    project: PROJECT_KEY,
    title: "Armed at birth",
    agent: PROJECT_AGENT_NAME,
  });
  refused(armed);
  expect(armed.text).toContain("unrecognized_keys");
  expect(armed.text).toContain("agent");
  expect(armed.text).toContain("use update_task, once the task exists");
  expect(armed.text).toContain("Nothing was written.");

  const listed = await session.callTool("list_tasks", { project: PROJECT_KEY });
  expect(listed.parsed).toHaveLength(4);

  const created = await session.callTool("create_task", { project: PROJECT_KEY, title: "The one that lands" });
  accepted(created);
  expect(created.parsed.taskNumber).toBe(NEXT_TASK_NUMBER);
  expect(created.parsed.status).toBe("planned");
});

test("change_task_status moves a free task and refuses one a worker holds", async ({
  page,
  request,
}) => {
  const session = await connected(request);

  const moved = await session.callTool("change_task_status", {
    taskKey: SIBLING_TASK_KEY,
    status: TARGET_COLUMN.id,
  });
  accepted(moved);
  expect(moved.parsed.status).toBe(TARGET_COLUMN.id);

  const held = await session.callTool("change_task_status", {
    taskKey: HELD_TASK_KEY,
    status: TARGET_COLUMN.id,
  });
  refused(held);
  expect(held.text).toContain(
    `${HELD_TASK_KEY} is being executed by ${WORKER_NAME} (phase ${RUN_PHASE})`
  );
  const direct = await request.patch(`/api/projects/${PROJECT_ID}/tasks/${HELD_TASK_ID}/status`, {
    headers: ADMIN_AUTH,
    data: { status: TARGET_COLUMN.id },
  });
  expect(direct.status()).toBe(409);
  expect(held.text).toContain((await direct.json()).error);

  const forced = await session.callTool("change_task_status", {
    taskKey: HELD_TASK_KEY,
    status: TARGET_COLUMN.id,
    force: true,
  });
  refused(forced);
  expect(forced.text).toContain("Not a parameter of this tool");
  expect(forced.text).toContain("force");
  expect(forced.text).toContain("machine credential");

  const nowhere = await session.callTool("change_task_status", {
    taskKey: SIBLING_TASK_KEY,
    status: "shipped",
  });
  refused(nowhere);
  expect(nowhere.text).toContain("Invalid status");

  await openBoard(page);
  await expect(cardIn(column(page, TARGET_COLUMN.id), SIBLING_TASK_NUMBER)).toBeVisible();
  await expect(cardIn(column(page, SOURCE_COLUMN.id), HELD_TASK_NUMBER)).toBeVisible();
  await expect(cardIn(column(page, TARGET_COLUMN.id), HELD_TASK_NUMBER)).toHaveCount(0);

  expect((await storedExecution(HELD_TASK_ID))?.runId).toBe("e2e-run-0001");
});

test("add_comment shows on the task under the token's holder, and a blank one is refused", async ({
  page,
  request,
}) => {
  const session = await connected(request);

  const added = await session.callTool("add_comment", {
    taskKey: SIBLING_TASK_KEY,
    body: "Noted over MCP",
  });
  accepted(added);
  expect(added.parsed.body).toBe("Noted over MCP");
  expect(added.parsed.author.username).toBe(ADMIN_USERNAME);

  const blank = await session.callTool("add_comment", { taskKey: SIBLING_TASK_KEY, body: "   " });
  refused(blank);
  expect(blank.text).toContain("Comment body is required");

  const missing = await session.callTool("add_comment", {
    taskKey: `${PROJECT_KEY}-99`,
    body: "On a task that does not exist",
  });
  refused(missing);
  expect(missing.text).toContain(`Task ${PROJECT_KEY}-99 not found`);

  const listed = await session.callTool("list_comments", { taskKey: SIBLING_TASK_KEY });
  expect(listed.parsed.map((c: { body: string }) => c.body)).toEqual(["Noted over MCP"]);

  await signIn(page);
  await page.goto(taskUrl(SIBLING_TASK_NUMBER));
  const panel = page.locator("#main-content");
  const comment = panel.locator("div.bg-bg-input", { hasText: "Noted over MCP" });
  await expect(comment).toBeVisible();
  await expect(comment.getByText("E2E Admin")).toBeVisible();
  await expect(panel.getByText("No comments yet")).toHaveCount(0);
});

test("sprints are created, listed and updated, and another board's sprint is out of reach", async ({
  page,
  request,
}) => {
  await seedSecondProject();
  await seedForeignSprint();
  const session = await connected(request);

  const created = await session.callTool("create_sprint", {
    project: PROJECT_KEY,
    name: "Sprint 9",
    startDate: "2026-09-07",
    endDate: "2026-09-20",
    goal: "Ship the MCP spec",
  });
  accepted(created);
  expect(created.parsed).toMatchObject({ name: "Sprint 9", status: "planned", goal: "Ship the MCP spec" });
  const sprintId: string = created.parsed._id;

  const listed = await session.callTool("list_sprints", { project: PROJECT_KEY });
  expect(listed.parsed).toHaveLength(1);
  expect(listed.parsed[0]).toMatchObject({ _id: sprintId, name: "Sprint 9", taskCount: 0, doneCount: 0 });

  const updated = await session.callTool("update_sprint", {
    project: PROJECT_KEY,
    sprintId,
    name: "Sprint 9 — MCP",
    status: "active",
  });
  accepted(updated);
  expect(updated.parsed).toMatchObject({ name: "Sprint 9 — MCP", status: "active" });

  const nothing = await session.callTool("update_sprint", { project: PROJECT_KEY, sprintId });
  refused(nothing);
  expect(nothing.text).toContain("named nothing to change");

  const noSuchStatus = await session.callTool("update_sprint", {
    project: PROJECT_KEY,
    sprintId,
    status: "abandoned",
  });
  refused(noSuchStatus);
  expect(noSuchStatus.text).toContain("Invalid sprint status");

  const missingEnd = await session.callTool("create_sprint", {
    project: PROJECT_KEY,
    name: "No end",
    startDate: "2026-09-07",
  });
  refused(missingEnd);
  expect(missingEnd.text).toContain("endDate");

  const foreign = await session.callTool("update_sprint", {
    project: PROJECT_KEY,
    sprintId: String(FOREIGN_SPRINT_ID),
    name: "Renamed from the wrong board",
  });
  refused(foreign);
  expect(foreign.text).toContain("Sprint not found");
  expect((await storedSprint(FOREIGN_SPRINT_ID))?.name).toBe(FOREIGN_SPRINT_NAME);

  const row = await storedSprint(new mongoose.Types.ObjectId(sprintId));
  expect(row).toMatchObject({ name: "Sprint 9 — MCP", status: "active", goal: "Ship the MCP spec" });
  expect(String(row?.project)).toBe(String(PROJECT_ID));
  expect((row?.startDate as Date).toISOString()).toBe("2026-09-07T00:00:00.000Z");
  expect((row?.endDate as Date).toISOString()).toBe("2026-09-20T00:00:00.000Z");

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/sprints`);
  const sprintList = page.getByRole("navigation", { name: "Sprint list" });
  await expect(sprintList.getByRole("button", { name: /^Sprint 9 — MCP\b/ })).toBeVisible();
  await expect(sprintList.getByRole("button", { name: /^Sprint 9\b/ })).toHaveCount(1);
});

test("update_task hands a task over by name: the assignee from the roster, the agent from the catalog", async ({
  request,
}) => {
  await seedAgents();
  const session = await connected(request);

  const assigned = await session.callTool("update_task", {
    taskKey: SIBLING_TASK_KEY,
    assignee: MEMBER_USERNAME.toUpperCase(),
  });
  accepted(assigned);
  expect(assigned.parsed.assignee.username).toBe(MEMBER_USERNAME);
  expect(assigned.parsed.assignedBy.username).toBe(ADMIN_USERNAME);

  const nobody = await session.callTool("update_task", { taskKey: SIBLING_TASK_KEY, assignee: "nobody" });
  refused(nobody);
  expect(nobody.text).toContain('"nobody" is not someone this board can be assigned to');
  expect(String((await storedTask(SIBLING_TASK_NUMBER)).assignee)).toBe(String(MEMBER_ID));

  const armed = await session.callTool("update_task", {
    taskKey: SIBLING_TASK_KEY,
    agent: PROJECT_AGENT_NAME.toLowerCase(),
  });
  accepted(armed);
  expect(armed.parsed.agent.name).toBe(PROJECT_AGENT_NAME);

  const noSuchAgent = await session.callTool("update_task", {
    taskKey: SIBLING_TASK_KEY,
    agent: "Nobody composed this",
  });
  refused(noSuchAgent);
  expect(noSuchAgent.text).toContain('Agent "Nobody composed this" not found');
  const stillArmed = await session.callTool("get_task", { taskKey: SIBLING_TASK_KEY });
  expect(stillArmed.parsed.agent.name).toBe(PROJECT_AGENT_NAME);

  const disarmed = await session.callTool("update_task", { taskKey: SIBLING_TASK_KEY, agent: "" });
  accepted(disarmed);
  expect(disarmed.parsed.agent).toBeNull();
  const unassigned = await session.callTool("update_task", { taskKey: SIBLING_TASK_KEY, assignee: "" });
  accepted(unassigned);
  expect(unassigned.parsed.assignee).toBeNull();

  const stored = await storedTask(SIBLING_TASK_NUMBER);
  expect(stored.assignee).toBeNull();
  expect(stored.agent ?? null).toBeNull();
});

test("a personal agent stays with its owner's tasks", async ({ request }) => {
  await seedAgents();
  const session = await connected(request);

  const theirs = await session.callTool("update_task", {
    taskKey: SIBLING_TASK_KEY,
    assignee: MEMBER_USERNAME,
    agent: PERSONAL_AGENT_NAME,
  });
  refused(theirs);
  expect(theirs.text).toContain("A personal agent only runs on your own tasks");
  const untouched = await storedTask(SIBLING_TASK_NUMBER);
  expect(untouched.assignee).toBeNull();
  expect(untouched.agent ?? null).toBeNull();

  const own = await session.callTool("update_task", {
    taskKey: SIBLING_TASK_KEY,
    assignee: ADMIN_USERNAME,
    agent: PERSONAL_AGENT_NAME,
  });
  accepted(own);
  expect(own.parsed.assignee.username).toBe(ADMIN_USERNAME);
  expect(own.parsed.assignedBy.username).toBe(ADMIN_USERNAME);
  expect(own.parsed.agent.name).toBe(PERSONAL_AGENT_NAME);

  const handedOn = await session.callTool("update_task", {
    taskKey: SIBLING_TASK_KEY,
    assignee: MEMBER_USERNAME,
  });
  accepted(handedOn);
  expect(handedOn.parsed.assignee.username).toBe(MEMBER_USERNAME);
  expect(handedOn.parsed.agent).toBeNull();

  const member = await connected(request, MEMBER_API_TOKEN);
  const borrowed = await member.callTool("update_task", {
    taskKey: SIBLING_TASK_KEY,
    agent: PERSONAL_AGENT_NAME,
  });
  refused(borrowed);
  expect(borrowed.text).toContain(`Agent "${PERSONAL_AGENT_NAME}" not found`);

  const shared = await member.callTool("update_task", {
    taskKey: SIBLING_TASK_KEY,
    agent: PROJECT_AGENT_NAME,
  });
  accepted(shared);
  expect(shared.parsed.agent.name).toBe(PROJECT_AGENT_NAME);
  const row = await storedTask(SIBLING_TASK_NUMBER);
  expect(String(row.agent)).toBe(String(PROJECT_AGENT_ID));
  expect(String(row.assignee)).toBe(String(MEMBER_ID));
});

test("an agent name belonging only to another board is refused as such, not written", async ({
  request,
}) => {
  await seedAgents();
  await seedSecondProject();
  await seedForeignAgent();
  const session = await connected(request);

  const foreign = await session.callTool("update_task", {
    taskKey: SIBLING_TASK_KEY,
    agent: FOREIGN_ONLY_AGENT_NAME,
  });
  refused(foreign);
  expect(foreign.text).toContain("another project");
  expect(foreign.text).not.toContain("cannot run on this project");
  const untouched = await storedTask(SIBLING_TASK_NUMBER);
  expect(untouched.agent ?? null).toBeNull();

  const own = await session.callTool("update_task", {
    taskKey: SIBLING_TASK_KEY,
    agent: PROJECT_AGENT_NAME,
  });
  accepted(own);
  expect(own.parsed.agent.name).toBe(PROJECT_AGENT_NAME);
});

test("a token limited to one board cannot write to another", async ({ page, request }) => {
  await seedSecondProject();
  await seedDemotableAdmin();

  const { accessToken } = await authorize(page, request, { projects: [String(PROJECT_ID)] });
  const session = new McpSession(request, accessToken);
  await session.open();

  const planted = await session.callTool("create_task", {
    project: SECOND_PROJECT_KEY,
    title: "Planted from outside",
  });
  refused(planted);
  expect(JSON.stringify(planted.raw)).not.toContain(SECOND_PROJECT_NAME);

  const commented = await session.callTool("add_comment", {
    taskKey: KEPT_TASK_KEY,
    body: "Whispered from outside",
  });
  refused(commented);

  const moved = await session.callTool("change_task_status", {
    taskKey: KEPT_TASK_KEY,
    status: SOURCE_COLUMN.id,
  });
  refused(moved);

  const asClient = { ...SAME_ORIGIN, Authorization: `Bearer ${accessToken}` };
  const straightIn = await request.post(`/api/projects/${SECOND_PROJECT_ID}/tasks`, {
    headers: asClient,
    data: { title: "Planted by the route" },
  });
  expect(straightIn.status(), await straightIn.text()).toBe(403);
  const straightHome = await request.post(`/api/projects/${PROJECT_ID}/tasks`, {
    headers: asClient,
    data: { title: "Filed by the route" },
  });
  expect(straightHome.status(), await straightHome.text()).toBe(201);

  const tasks = await request.get(`/api/projects/${SECOND_PROJECT_ID}/tasks`, { headers: ADMIN_AUTH });
  expect(tasks.status()).toBe(200);
  expect((await tasks.json()).map((t: { title: string; status: string }) => [t.title, t.status])).toEqual([
    [KEPT_TASK_TITLE, "todo"],
  ]);
  const comments = await request.get(
    `/api/projects/${SECOND_PROJECT_ID}/tasks/${KEPT_TASK_ID}/comments`,
    { headers: ADMIN_AUTH }
  );
  expect(await comments.json()).toEqual([]);

  const created = await session.callTool("create_task", { project: PROJECT_KEY, title: "Filed from inside" });
  accepted(created);
  expect(created.parsed.taskNumber).toBe(NEXT_TASK_NUMBER + 1);
  const noted = await session.callTool("add_comment", { taskKey: SIBLING_TASK_KEY, body: "Said from inside" });
  accepted(noted);
  expect(noted.parsed.body).toBe("Said from inside");
  const shifted = await session.callTool("change_task_status", {
    taskKey: SIBLING_TASK_KEY,
    status: TARGET_COLUMN.id,
  });
  accepted(shifted);
  expect(shifted.parsed.status).toBe(TARGET_COLUMN.id);

  expect((await storedTask(NEXT_TASK_NUMBER + 1)).title).toBe("Filed from inside");
  expect((await storedTask(SIBLING_TASK_NUMBER)).status).toBe(TARGET_COLUMN.id);
  const said = await request.get(
    `/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}/comments`,
    { headers: ADMIN_AUTH }
  );
  expect((await said.json()).map((c: { body: string }) => c.body)).toEqual(["Said from inside"]);
});

test("an outage answers 503 and says the credential was not the problem", async ({ request }) => {
  const session = await connected(request);

  await request.post(`${MONGO_PROXY_CONTROL_URL}/outage`);
  const cut = await session.call("tools/list");
  expect(cut.status, cut.text).toBe(503);
  expect(JSON.parse(cut.text)).toEqual({
    error: "temporarily_unavailable",
    error_description: "The database is unreachable. The credential was not the problem.",
  });
  expect(cut.headers["retry-after"]).toBe("5");
  expect(cut.headers["www-authenticate"]).toBeUndefined();
  expect(cut.text).not.toContain("invalid_token");
  await request.post(`${MONGO_PROXY_CONTROL_URL}/restore`);

  await expect(async () => {
    expect((await session.call("tools/list")).status).toBe(200);
  }).toPass({ timeout: 30_000 });
  const tasks = await session.callTool("list_tasks", { project: PROJECT_KEY });
  expect(tasks.text).toContain(HELD_TASK_TITLE);
});
