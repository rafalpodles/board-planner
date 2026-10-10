import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { MONGO_PROXY_CONTROL_URL } from "../playwright.config";
import { ADMIN_AUTH, SAME_ORIGIN } from "./api";
import { SERVER_INSTRUCTIONS } from "../src/lib/mcp/instructions";
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
  seedRuns,
  RUN_TASK_KEY,
  seedCustomFields,
  seedDemotableAdmin,
  seedForeignAgent,
  seedForeignSprint,
  seedSecondProject,
  storedExecution,
  storedSprint,
  storedTask,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-464 — the tools an AI client edits a board through, driven over the real transport. Every
 * write here ends on what the board holds afterwards — a card in its column, a comment on the
 * task, a row in the database — rather than on the tool's own reply, because the reply is the one
 * thing a tool that wrote nothing can still get right (BP-497).
 *
 * The credential is the seeded `cp_` API token, which getAuthUser accepts as a Bearer on /api/mcp,
 * so only the scope test pays for the consent screen: that one needs a token limited to a board,
 * which nothing but the consent screen can mint.
 */

// seed() lays down four tasks and leaves taskCounter on the same number: the first task created
// here is minted with this, and a refused create must not spend it (BP-438).
const NEXT_TASK_NUMBER = 5;

const boardUrl = `/projects/${PROJECT_KEY}`;
const taskUrl = (taskNumber: number) => `/projects/${PROJECT_KEY}/tasks/${taskNumber}`;

function column(page: Page, columnId: string): Locator {
  return page.getByTestId(`column-${columnId}`);
}

function cardIn(column: Locator, taskNumber: number): Locator {
  return column.locator(`a[href="${taskUrl(taskNumber)}"]`);
}

/** The board as a person sees it. */
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

// Both check the transport first: a 401 or a JSON-RPC error carries no `result`, and an
// `isError ?? false` read off nothing would call that accepted
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

// The outage test cuts the database; a body abandoned by the test timeout never reaches its own
// restore, and every test after it would read 503s. afterEach runs on a timeout too.
test.afterEach(async ({ request }) => {
  await request.post(`${MONGO_PROXY_CONTROL_URL}/restore`);
});

test("initialize hands the client the board's working rules", async ({ request }) => {
  const session = new McpSession(request, API_TOKEN);
  const answer = await session.open();

  expect(answer.result?.instructions).toBe(SERVER_INSTRUCTIONS);
});

test("create_task lands on the board with everything it named", async ({ page, request }) => {
  const session = await connected(request);

  const created = await session.callTool("create_task", {
    project: PROJECT_KEY,
    title: "Filed over MCP",
    description: "Written by an agent, not a person",
    priority: "high",
    category: "bug",
    // Named rather than defaulted: the default is the first backlog column, so leaving it out
    // would not say whether a named one is honoured
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
  // The hand-over is recorded against the token's holder, which is what a machine's claim reads
  expect(created.parsed.assignedBy.username).toBe(ADMIN_USERNAME);
  expect(created.parsed.checklist.map((item: { text: string; done: boolean }) => [item.text, item.done])).toEqual([
    ["the card is on the board", false],
    ["with its checklist", false],
  ]);

  await openBoard(page);
  const card = cardIn(column(page, SPARE_COLUMN.id), NEXT_TASK_NUMBER);
  await expect(card).toBeVisible();
  await expect(card).toContainText("Filed over MCP");
  // In that column and no other
  await expect(page.locator(`[data-column-body] a[href="${taskUrl(NEXT_TASK_NUMBER)}"]`)).toHaveCount(1);

  // And the tool's own read agrees with the board
  const readBack = await session.callTool("get_task", { taskKey: `${PROJECT_KEY}-${NEXT_TASK_NUMBER}` });
  expect(readBack.parsed.title).toBe("Filed over MCP");
  expect(readBack.parsed.assignee.username).toBe(MEMBER_USERNAME);
});

/**
 * Refused the way the REST API refuses, and — the part a reply cannot show — without spending a
 * task number. BP-438: every refusal past the counter's `$inc` left a permanent hole in the
 * board's numbering for a task that never existed, so the number the eventual task is minted
 * with is the assertion.
 */
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

  // A parameter the tool does not declare: named, pointed at its home, and nothing written
  const armed = await session.callTool("create_task", {
    project: PROJECT_KEY,
    title: "Armed at birth",
    agent: PROJECT_AGENT_NAME,
  });
  refused(armed);
  // The SDK wraps the refusal in its own validation error, quotes escaped, so the wording is
  // asserted in pieces rather than as one phrase
  expect(armed.text).toContain("Input validation error");
  expect(armed.text).toContain("create_task");
  expect(armed.text).toContain("agent");
  expect(armed.text).toContain("use update_task, once the task exists");
  expect(armed.text).toContain("Nothing was written.");

  const listed = await session.callTool("list_tasks", { project: PROJECT_KEY });
  expect(listed.parsed.total).toBe(4);

  // The control, and the number: five refusals cost nothing
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

  // The same 409 the board and the edit form give, in the same words (run-conflict.spec.ts)
  const held = await session.callTool("change_task_status", {
    taskKey: HELD_TASK_KEY,
    status: TARGET_COLUMN.id,
  });
  refused(held);
  expect(held.text).toContain(
    `${HELD_TASK_KEY} is being executed by ${WORKER_NAME} (phase ${RUN_PHASE})`
  );
  // The status the tool cannot carry — PlannerClient keeps only the message — is read off the
  // same write made directly: a 409, whose words the tool's are, rather than a copy of them
  const direct = await request.patch(`/api/projects/${PROJECT_ID}/tasks/${HELD_TASK_ID}/status`, {
    headers: ADMIN_AUTH,
    data: { status: TARGET_COLUMN.id },
  });
  expect(direct.status()).toBe(409);
  expect(held.text).toContain((await direct.json()).error);

  // The way past it exists for a person on the board, and not for this tool: an MCP token is a
  // machine credential, and an unattended agent must not take work off a machine
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

  // Still held, not merely still in the column: a release that left the card where it was would
  // pass the board check above
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
  expect(listed.parsed.comments.map((c: { body: string }) => c.body)).toEqual(["Noted over MCP"]);

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

  // BP-314: a sprint id belonging to another board, named through this one, is refused as if it
  // did not exist — and the other board's sprint is left exactly as it was
  const foreign = await session.callTool("update_sprint", {
    project: PROJECT_KEY,
    sprintId: String(FOREIGN_SPRINT_ID),
    name: "Renamed from the wrong board",
  });
  refused(foreign);
  expect(foreign.text).toContain(`No sprint "${FOREIGN_SPRINT_ID}"`);
  expect((await storedSprint(FOREIGN_SPRINT_ID))?.name).toBe(FOREIGN_SPRINT_NAME);

  const row = await storedSprint(new mongoose.Types.ObjectId(sprintId));
  expect(row).toMatchObject({ name: "Sprint 9 — MCP", status: "active", goal: "Ship the MCP spec" });
  expect(String(row?.project)).toBe(String(PROJECT_ID));
  expect((row?.startDate as Date).toISOString()).toBe("2026-09-07T00:00:00.000Z");
  expect((row?.endDate as Date).toISOString()).toBe("2026-09-20T00:00:00.000Z");

  // The sprint list a person sees offers it, under the name the update gave it
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

  // Case does not decide: the roster holds "member" and the caller wrote it in capitals
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
  // BP-511: refused, not resolved to nobody — and not to anybody else either
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

  // The empty string is the whole of "nobody runs it", for both fields
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

/**
 * A personal agent is somebody's own prompts with write access, and a task carries it only while
 * it belongs to that person: pointing a colleague's task at it is refused whole — the assignee in
 * the same call does not move either — and handing the task on drops it.
 */
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
  // The seeded row never had the field; a refused write must not have given it one either
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

  // Handing the task to somebody else is a new hand-over, and the agent that rode the old one has
  // no standing on it
  const handedOn = await session.callTool("update_task", {
    taskKey: SIBLING_TASK_KEY,
    assignee: MEMBER_USERNAME,
  });
  accepted(handedOn);
  expect(handedOn.parsed.assignee.username).toBe(MEMBER_USERNAME);
  expect(handedOn.parsed.agent).toBeNull();

  // Withheld from anybody else's catalog, so from the member it does not resolve at all — and the
  // refusal does not say whether it exists
  const member = await connected(request, MEMBER_API_TOKEN);
  const borrowed = await member.callTool("update_task", {
    taskKey: SIBLING_TASK_KEY,
    agent: PERSONAL_AGENT_NAME,
  });
  refused(borrowed);
  expect(borrowed.text).toContain(`Agent "${PERSONAL_AGENT_NAME}" not found`);

  // The control: a project agent is the board's, and a member who may edit the task may choose it
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

/**
 * BP-496. `/api/agents` sends the project agents of every project the caller can reach, not just
 * the task's own — for an instance admin, every project on the instance. An agent name resolved
 * against that whole list used to reach the write only to be refused by `agentUsableOnProject`
 * (`"That agent cannot run on this project"`), a rule the caller has no way to see coming.
 * Resolution itself now refuses it, naming the actual problem, and touches nothing.
 */
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

  // The control: the seeded board's own agent still resolves exactly as before
  const own = await session.callTool("update_task", {
    taskKey: SIBLING_TASK_KEY,
    agent: PROJECT_AGENT_NAME,
  });
  accepted(own);
  expect(own.parsed.agent.name).toBe(PROJECT_AGENT_NAME);
});

/**
 * mcp-oauth.spec.ts proves a token limited to one board cannot READ the other. This is the arm
 * that matters: it cannot write there either, through any of the three writers, and the refusal
 * does not name the board it was kept from.
 */
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

  // Those three stopped at the listing the token cannot see past (`getProjectByKey`), which says
  // nothing about the write gate itself. The same credential at the route is the gate: refused
  // on the board it was not granted, and — the control — a real write on the one it was
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

  // The other board, read with a credential that can see it: one task, where it was, with no
  // comment on it
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

  // The control: the same three writes land on the board the token was granted
  const created = await session.callTool("create_task", { project: PROJECT_KEY, title: "Filed from inside" });
  accepted(created);
  // The route's own write above took NEXT_TASK_NUMBER
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

  // And the board holds all three
  expect((await storedTask(NEXT_TASK_NUMBER + 1)).title).toBe("Filed from inside");
  expect((await storedTask(SIBLING_TASK_NUMBER)).status).toBe(TARGET_COLUMN.id);
  const said = await request.get(
    `/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}/comments`,
    { headers: ADMIN_AUTH }
  );
  expect((await said.json()).map((c: { body: string }) => c.body)).toEqual(["Said from inside"]);
});

/**
 * BP-362. withMcpAuth answers everything verifyToken throws with `invalid_token`, and a client
 * that reads that discards a working credential and walks the whole flow again for another one
 * that fails the same way. The 503 is worded so it does not.
 */
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
  // Not a challenge: a 401's pointer to the discovery documents would send the client off to
  // re-authorise for a token that was never the problem
  expect(cut.headers["www-authenticate"]).toBeUndefined();
  expect(cut.text).not.toContain("invalid_token");
  await request.post(`${MONGO_PROXY_CONTROL_URL}/restore`);

  // The control: the same credential, the same session, once the database is back
  await expect(async () => {
    expect((await session.call("tools/list")).status).toBe(200);
  }).toPass({ timeout: 30_000 });
  const tasks = await session.callTool("list_tasks", { project: PROJECT_KEY });
  expect(tasks.text).toContain(HELD_TASK_TITLE);
});

/**
 * BP-564. Every refusal here is handed to a model as a tool result, so an unbounded echo of the
 * caller's own argument lets the caller decide how much of the reader's context the answer to its
 * own bad request takes. Driven over the real HTTP+OAuth endpoint, because that is the surface the
 * PM agent and every token holder actually use.
 */
test("a refusal quotes the caller back, but only so much of it", async ({ request }) => {
  await seedAgents();
  const session = await connected(request);
  const huge = "z".repeat(50_000);

  const assignee = await session.callTool("update_task", {
    taskKey: SIBLING_TASK_KEY,
    assignee: huge,
  });
  refused(assignee);
  expect(assignee.text).toContain(`"${"z".repeat(64)}…" is not someone this board`);
  expect(assignee.text.length).toBeLessThan(400);

  const agent = await session.callTool("update_task", { taskKey: SIBLING_TASK_KEY, agent: huge });
  refused(agent);
  expect(agent.text).toContain(`Agent "${"z".repeat(64)}…" not found`);
  expect(agent.text.length).toBeLessThan(400);

  const field = await session.callTool("update_task", {
    taskKey: SIBLING_TASK_KEY,
    fields: { [huge]: "x" },
  });
  refused(field);
  expect(field.text).toContain(`Unknown field "${"z".repeat(64)}…"`);
  expect(field.text.length).toBeLessThan(600);

  // A name anybody would really send is still quoted whole
  const short = await session.callTool("update_task", {
    taskKey: SIBLING_TASK_KEY,
    assignee: "nobody",
  });
  refused(short);
  expect(short.text).toContain('"nobody" is not someone this board');
});

/**
 * Linking tasks over MCP. An epic used to be able to hold its parts only as checklist items — text
 * nothing can move, assign or run — because the relations the board stores had no tool. The two
 * assertions that matter are on the *other* task: a parent written from one end has to appear as a
 * parent from the other, which is the reverse lookup the task route computes rather than anything
 * the write returned.
 */
test("link_tasks builds a parent and its child, and unlink_tasks takes it apart", async ({
  page,
  request,
}) => {
  const session = await connected(request);

  const linked = await session.callTool("link_tasks", {
    taskKey: HELD_TASK_KEY,
    targetTaskKey: SIBLING_TASK_KEY,
    type: "parent_of",
  });
  accepted(linked);

  await signIn(page);

  // The parent's own page: the child is under Children
  await page.goto(taskUrl(HELD_TASK_NUMBER));
  await expect(page.getByText(HELD_TASK_TITLE).first()).toBeVisible();
  const children = page.getByRole("heading", { name: "Children", level: 4, exact: true });
  await expect(children).toBeVisible();
  // Scoped to the section rather than the page: unscoped, this asserts the page mentions the key
  // somewhere, which a breadcrumb or a card would satisfy without any link existing
  await expect(children.locator("..").getByText(SIBLING_TASK_KEY, { exact: true })).toBeVisible();

  // blocked_by is a different array reached down a different branch of the route, and the tool
  // description promises it stacks with the relations rather than replacing them
  const alsoBlocked = await session.callTool("link_tasks", {
    taskKey: HELD_TASK_KEY,
    targetTaskKey: SIBLING_TASK_KEY,
    type: "blocked_by",
  });
  accepted(alsoBlocked);
  await page.reload();
  const blockedBy = page.getByRole("heading", { name: "Blocked by", level: 4, exact: true });
  await expect(blockedBy).toBeVisible();
  await expect(blockedBy.locator("..").getByText(SIBLING_TASK_KEY, { exact: true })).toBeVisible();
  await expect(children).toBeVisible();

  // The child's page, which nothing wrote to: the parent arrives from the reverse lookup
  await page.goto(taskUrl(SIBLING_TASK_NUMBER));
  const parent = page.getByRole("heading", { name: "Parent", level: 4, exact: true });
  await expect(parent).toBeVisible();
  // Scoped: the same key is also under "Is blocking" on this page, and an unscoped match would be
  // satisfied by either — which is to say by neither in particular
  await expect(parent.locator("..").getByText(HELD_TASK_KEY, { exact: true })).toBeVisible();

  // The link is stored on the parent, so asking from the child's end removes nothing — and the
  // route would still answer "Dependency removed". The refusal is the tool's, and it has to leave
  // the link standing.
  const fromTheWrongEnd = await session.callTool("unlink_tasks", {
    taskKey: SIBLING_TASK_KEY,
    targetTaskKey: HELD_TASK_KEY,
    type: "parent_of",
  });
  refused(fromTheWrongEnd);
  expect(fromTheWrongEnd.text).toContain(`${HELD_TASK_KEY} holds that parent_of link`);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Parent", level: 4, exact: true })).toBeVisible();

  const unlinked = await session.callTool("unlink_tasks", {
    taskKey: HELD_TASK_KEY,
    targetTaskKey: SIBLING_TASK_KEY,
    type: "parent_of",
  });
  accepted(unlinked);

  await page.goto(taskUrl(HELD_TASK_NUMBER));
  // The positive first: a heading only a loaded task page has, so an empty Children section is
  // read off a rendered page rather than off one that never arrived
  await expect(page.getByText(HELD_TASK_TITLE).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Children", level: 4, exact: true })).toHaveCount(0);
});

/**
 * The far end is resolved here rather than left to the route, which scopes it to the same project
 * and would answer "Task not found" — a sentence that sends the caller looking for a typo in a key
 * that resolved perfectly well. This credential is an instance admin's, so both boards really are
 * visible to it: the refusal is the rule, not a listing the token cannot see past.
 */
test("link_tasks refuses a pair on two boards and names them", async ({ request }) => {
  await seedSecondProject();
  await seedDemotableAdmin();
  const session = await connected(request);

  const across = await session.callTool("link_tasks", {
    taskKey: HELD_TASK_KEY,
    targetTaskKey: KEPT_TASK_KEY,
    type: "relates",
  });
  refused(across);
  expect(across.text).toContain(`${HELD_TASK_KEY} and ${KEPT_TASK_KEY} are on different boards`);

  // The control: the same call within one board is accepted, so the refusal above is about the
  // pair and not about link_tasks being broken
  const within = await session.callTool("link_tasks", {
    taskKey: HELD_TASK_KEY,
    targetTaskKey: SIBLING_TASK_KEY,
    type: "relates",
  });
  accepted(within);

  // Ends on what the board holds, not on the reply: an accepted call is the one thing a write that
  // stored nothing can still get right
  const readBack = await session.callTool("get_task", { taskKey: HELD_TASK_KEY });
  expect(readBack.parsed.relations).toEqual([
    expect.objectContaining({
      type: "relates",
      task: expect.objectContaining({ taskNumber: SIBLING_TASK_NUMBER }),
    }),
  ]);
});

const cardsIn = (column: Locator) =>
  column
    .locator("[data-column-body] a[href*='/tasks/']")
    .evaluateAll((cards) => cards.map((card) => card.getAttribute("href")));

const keyOf = (href: string | null) => `${PROJECT_KEY}-${href?.split("/").pop()}`;

async function storedOrders(request: APIRequestContext, projectId: { toString(): string }) {
  const response = await request.get(`/api/projects/${projectId}/tasks`, { headers: ADMIN_AUTH });
  expect(response.status()).toBe(200);
  const tasks = (await response.json()) as { taskNumber: number; order: number }[];
  return Object.fromEntries(tasks.map((t) => [t.taskNumber, t.order]));
}

test("reorder_tasks puts a column's cards in the order given, and the board shows it", async ({
  page,
  request,
}) => {
  const session = await connected(request);
  for (const title of ["Filed first", "Filed second", "Filed third"]) {
    accepted(await session.callTool("create_task", { project: PROJECT_KEY, title, status: SPARE_COLUMN.id }));
  }

  await openBoard(page);
  const todo = column(page, SPARE_COLUMN.id);
  const inProgress = column(page, SOURCE_COLUMN.id);
  await expect(cardIn(todo, NEXT_TASK_NUMBER + 2)).toBeVisible();
  const before = (await cardsIn(todo)).map(keyOf);
  expect(before).toHaveLength(4);
  const otherColumn = await cardsIn(inProgress);
  expect(otherColumn.length).toBeGreaterThan(1);

  await test.step("the whole column, reversed", async () => {
    const wanted = [...before].reverse();
    const reordered = await session.callTool("reorder_tasks", { project: PROJECT_KEY, taskKeys: wanted });
    accepted(reordered);

    await page.reload();
    await expect(cardIn(todo, NEXT_TASK_NUMBER)).toBeVisible();
    expect((await cardsIn(todo)).map(keyOf)).toEqual(wanted);
    expect(await cardsIn(inProgress)).toEqual(otherColumn);
  });

  await test.step("two cards named, the ones between them keep their places", async () => {
    const [first, second, third, last] = [...before].reverse();
    const reordered = await session.callTool("reorder_tasks", {
      project: PROJECT_KEY,
      taskKeys: [last, first],
    });
    accepted(reordered);

    await page.reload();
    await expect(cardIn(todo, NEXT_TASK_NUMBER)).toBeVisible();
    expect((await cardsIn(todo)).map(keyOf)).toEqual([last, second, third, first]);
    expect(await cardsIn(inProgress)).toEqual(otherColumn);
  });
});

test("reorder_tasks refuses keys it cannot place, and a board the caller cannot reach, writing nothing", async ({
  request,
}) => {
  await seedSecondProject();
  await seedDemotableAdmin();
  const before = await storedOrders(request, PROJECT_ID);
  const foreignBefore = await storedOrders(request, SECOND_PROJECT_ID);

  const admin = await connected(request);
  for (const [taskKeys, says] of [
    [[SIBLING_TASK_KEY, `${PROJECT_KEY}-99`], `${PROJECT_KEY}-99 does not exist`],
    [[SIBLING_TASK_KEY, HELD_TASK_KEY, SIBLING_TASK_KEY], `${SIBLING_TASK_KEY} is listed more than once`],
    [[SIBLING_TASK_KEY, KEPT_TASK_KEY], `"${KEPT_TASK_KEY}" is not a ${PROJECT_KEY} task key`],
  ] as const) {
    const call = await admin.callTool("reorder_tasks", { project: PROJECT_KEY, taskKeys: [...taskKeys] });
    refused(call);
    expect(call.text).toContain(says);
    expect(call.text).toContain("nothing was reordered");
  }

  const tooMany = await admin.callTool("reorder_tasks", {
    project: PROJECT_KEY,
    taskKeys: Array.from({ length: 1001 }, (_, i) => `${PROJECT_KEY}-${i + 1}`),
  });
  expect(tooMany.status).toBe(200);
  expect(tooMany.raw.result?.isError ?? Boolean(tooMany.raw.error), tooMany.text).toBe(true);

  const member = await connected(request, MEMBER_API_TOKEN);
  const unreachable = await member.callTool("reorder_tasks", {
    project: SECOND_PROJECT_KEY,
    taskKeys: [KEPT_TASK_KEY],
  });
  refused(unreachable);
  expect(unreachable.text).not.toContain(SECOND_PROJECT_NAME);

  expect(await storedOrders(request, PROJECT_ID)).toEqual(before);
  expect(await storedOrders(request, SECOND_PROJECT_ID)).toEqual(foreignBefore);

  // The control: the same member, on a board it can reach, is not refused
  const reachable = await member.callTool("reorder_tasks", {
    project: PROJECT_KEY,
    taskKeys: [SIBLING_TASK_KEY, HELD_TASK_KEY],
  });
  accepted(reachable);
  const after = await storedOrders(request, PROJECT_ID);
  expect(after[SIBLING_TASK_NUMBER]).toBeLessThan(after[HELD_TASK_NUMBER]);
});

/**
 * BP-904. A project key may hold digits, hyphens and underscores, and the tools parsed only
 * letters — so a board keyed MY_APP could be created, shown and worked in the browser and was
 * invisible to every key-addressed tool. Each board here is made the way a person would, through
 * the API, and every tool is then driven by the key it would be given.
 */
for (const key of ["BP2", "MY_APP", "MY-APP"]) {
  test(`every key-addressed tool works on a board keyed ${key}`, async ({ request }) => {
    const created = await request.post("/api/projects", {
      headers: ADMIN_AUTH,
      data: { name: `Odd key ${key}`, key },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { _id: projectId } = (await created.json()) as { _id: string };

    for (const title of ["First", "Second"]) {
      const task = await request.post(`/api/projects/${projectId}/tasks`, { headers: ADMIN_AUTH, data: { title } });
      expect(task.status(), await task.text()).toBe(201);
    }
    const first = `${key}-1`;
    const second = `${key}-2`;
    const session = await connected(request);

    const read = await session.callTool("get_task", { taskKey: second });
    accepted(read);
    expect(read.parsed).toMatchObject({ taskNumber: 2, title: "Second" });

    // Each write ends on what the board holds, not on the reply
    accepted(await session.callTool("update_task", { taskKey: second, title: "Renamed" }));
    accepted(await session.callTool("change_task_status", { taskKey: second, status: "in_progress" }));
    accepted(await session.callTool("add_comment", { taskKey: second, body: `noted on ${key}` }));
    accepted(await session.callTool("link_tasks", { taskKey: first, targetTaskKey: second, type: "parent_of" }));

    const stored = await request.get(`/api/projects/${projectId}/tasks?taskNumber=2`, { headers: ADMIN_AUTH });
    expect(stored.status()).toBe(200);
    expect((await stored.json()) as unknown[]).toEqual([
      expect.objectContaining({ taskNumber: 2, title: "Renamed", status: "in_progress" }),
    ]);

    const comments = await session.callTool("list_comments", { taskKey: second });
    accepted(comments);
    expect(comments.parsed.comments.map((c: { body: string }) => c.body)).toEqual([`noted on ${key}`]);

    accepted(await session.callTool("unlink_tasks", { taskKey: first, targetTaskKey: second, type: "parent_of" }));
  });
}

test("a task key that names nothing is refused as such, and a malformed one as malformed", async ({ request }) => {
  const session = await connected(request);

  const absent = await session.callTool("get_task", { taskKey: `${PROJECT_KEY}-9999` });
  refused(absent);
  expect(absent.text).toContain(`Task ${PROJECT_KEY}-9999 not found`);

  const unknownBoard = await session.callTool("get_task", { taskKey: "NOSUCH-1" });
  refused(unknownBoard);
  expect(unknownBoard.text).toContain('Project with key "NOSUCH" not found');

  const malformed = await session.callTool("get_task", { taskKey: `${PROJECT_KEY}1` });
  refused(malformed);
  expect(malformed.text).toContain(`Invalid task key: "${PROJECT_KEY}1"`);

  // The number exists, but on the other board: the lookup is scoped to the board the key names
  await seedSecondProject();
  await seedDemotableAdmin();
  const wrongBoard = await session.callTool("get_task", { taskKey: `${SECOND_PROJECT_KEY}-${SIBLING_TASK_NUMBER}` });
  refused(wrongBoard);
  expect(wrongBoard.text).toContain(`Task ${SECOND_PROJECT_KEY}-${SIBLING_TASK_NUMBER} not found`);

  const own = await session.callTool("get_task", { taskKey: KEPT_TASK_KEY });
  accepted(own);
  expect(own.parsed.title).toBe(KEPT_TASK_TITLE);
});

/**
 * BP-907. The answers are what a bulk run reads back, so they are asserted against what the board
 * holds: the key in a minimal answer opens the task it names, and the keys get_task prints for a
 * link are the ones the other end carries.
 */
test("minimal answers carry the key and a link that opens the task, and the full answer stays the default", async ({
  page,
  request,
}) => {
  await signIn(page);
  const session = await connected(request);

  const created = await session.callTool("create_task", {
    project: PROJECT_KEY,
    title: "Filed minimally",
    priority: "high",
    assignee: MEMBER_USERNAME,
    minimal: true,
  });
  accepted(created);
  const key = `${PROJECT_KEY}-${NEXT_TASK_NUMBER}`;
  expect(created.parsed).toEqual({
    key,
    title: "Filed minimally",
    status: expect.any(String),
    priority: "high",
    assignee: MEMBER_USERNAME,
    url: expect.stringMatching(new RegExp(`/projects/${PROJECT_KEY}/tasks/${NEXT_TASK_NUMBER}$`)),
  });

  // The link goes where it says
  await page.goto(new URL(created.parsed.url).pathname);
  await expect(page.getByText("Filed minimally").first()).toBeVisible();

  const renamed = await session.callTool("update_task", { taskKey: key, title: "Renamed minimally", minimal: true });
  accepted(renamed);
  expect(renamed.parsed).toMatchObject({ key, title: "Renamed minimally" });
  expect(Object.keys(renamed.parsed).sort()).toEqual(["assignee", "key", "priority", "status", "title", "url"]);

  const moved = await session.callTool("change_task_status", { taskKey: key, status: SPARE_COLUMN.id, minimal: true });
  accepted(moved);
  expect(moved.parsed).toMatchObject({ key, status: SPARE_COLUMN.id });

  // The stored task agrees with what was reported, and unasked-for minimal leaves the full answer
  const full = await session.callTool("update_task", { taskKey: key, description: "now with a body" });
  accepted(full);
  expect(full.parsed).toMatchObject({ taskNumber: NEXT_TASK_NUMBER, title: "Renamed minimally", status: SPARE_COLUMN.id });
  expect(full.parsed.checklist).toBeDefined();
  expect(full.parsed.createdBy.username).toBe(ADMIN_USERNAME);
});

test("link_tasks says what it linked, and get_task names the parent and children by key", async ({ request }) => {
  const session = await connected(request);

  const linked = await session.callTool("link_tasks", {
    taskKey: HELD_TASK_KEY,
    targetTaskKey: SIBLING_TASK_KEY,
    type: "parent_of",
  });
  accepted(linked);
  expect(linked.parsed).toEqual({
    message: `Linked: ${HELD_TASK_KEY} is the parent of ${SIBLING_TASK_KEY}`,
    taskKey: HELD_TASK_KEY,
    targetTaskKey: SIBLING_TASK_KEY,
    type: "parent_of",
  });

  const parent = await session.callTool("get_task", { taskKey: HELD_TASK_KEY });
  expect(parent.parsed.children).toEqual([
    expect.objectContaining({ key: SIBLING_TASK_KEY, title: expect.any(String), status: expect.any(String) }),
  ]);
  expect(parent.parsed.relations[0].task.key).toBe(SIBLING_TASK_KEY);

  const child = await session.callTool("get_task", { taskKey: SIBLING_TASK_KEY });
  expect(child.parsed.parent).toEqual(expect.objectContaining({ key: HELD_TASK_KEY }));
  expect(child.parsed.relatedFrom[0].task.key).toBe(HELD_TASK_KEY);

  const unlinked = await session.callTool("unlink_tasks", {
    taskKey: HELD_TASK_KEY,
    targetTaskKey: SIBLING_TASK_KEY,
    type: "parent_of",
  });
  accepted(unlinked);
  expect(unlinked.parsed.message).toBe(`Removed: ${HELD_TASK_KEY} is the parent of ${SIBLING_TASK_KEY}`);
  expect((await session.callTool("get_task", { taskKey: HELD_TASK_KEY })).parsed.children).toEqual([]);
});

/**
 * BP-906. A listing has to fit in a model's context and has to say what it left out: one ordinary
 * query on the BP board was 393,665 characters. Everything below ends on keys read back from the
 * tool, checked against tasks this test made and so knows the answer for.
 */
const keysOf = (call: ToolCall) => (call.parsed.tasks as { key: string }[]).map((t) => t.key);

async function fileTask(session: McpSession, args: Record<string, unknown>) {
  const created = await session.callTool("create_task", { project: PROJECT_KEY, ...args });
  accepted(created);
  return { key: `${PROJECT_KEY}-${created.parsed.taskNumber}`, id: created.parsed._id as string };
}

test("list_tasks answers in short lines, a page at a time, and says where the next page starts", async ({ request }) => {
  const session = await connected(request);
  const made = [];
  for (const n of [1, 2, 3, 4, 5]) made.push((await fileTask(session, { title: `Paged ${n}` })).key);

  const first = await session.callTool("list_tasks", { project: PROJECT_KEY, limit: 2 });
  accepted(first);
  expect(first.parsed).toMatchObject({ returned: 2, offset: 0, nextOffset: 2 });
  expect(first.parsed.total).toBeGreaterThanOrEqual(made.length);
  // A line, not a body: no checklist, no organisation, no author — and the keys to act on it by
  expect(Object.keys(first.parsed.tasks[0]).sort()).toEqual(
    ["assignee", "dueDate", "key", "parent", "priority", "sprint", "status", "title"]
  );
  expect(first.text.length).toBeLessThan(2_000);

  // Following nextOffset reads the whole board once: no task twice, none missed
  const seen: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page: ToolCall = await session.callTool("list_tasks", { project: PROJECT_KEY, limit: 2, offset });
    accepted(page);
    seen.push(...keysOf(page));
    offset = page.parsed.nextOffset;
  }
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen).toHaveLength(first.parsed.total);
  for (const key of made) expect(seen).toContain(key);

  const full = await session.callTool("list_tasks", { project: PROJECT_KEY, limit: 1, detail: "full" });
  accepted(full);
  expect(full.parsed.tasks[0].checklist).toBeDefined();
  expect(full.parsed.tasks[0].createdBy).toBeDefined();
});

test("list_tasks narrows by sprint, text, due date, parent, blocker and field", async ({ request }) => {
  await seedCustomFields();
  const session = await connected(request);

  const large = await fileTask(session, {
    title: "Needle large",
    fields: { Difficulty: "L", Platforms: ["iOS", "Web"], "Spike?": true },
  });
  const small = await fileTask(session, { title: "Other small", fields: { Difficulty: "S" } });
  const plain = await fileTask(session, { title: "Plain" });

  // A sprint, a due date: set through the API, since this PR is about reading them back
  const sprint = await session.callTool("create_sprint", {
    project: PROJECT_KEY,
    name: "Hardening",
    startDate: "2026-10-01",
    endDate: "2026-10-14",
  });
  accepted(sprint);
  const put = (id: string, data: Record<string, unknown>) =>
    request.put(`/api/projects/${PROJECT_ID}/tasks/${id}`, { headers: ADMIN_AUTH, data });
  expect((await put(large.id, { sprint: sprint.parsed._id })).status()).toBe(200);
  expect((await put(small.id, { dueDate: "2026-10-10" })).status()).toBe(200);

  const list = async (args: Record<string, unknown>) => {
    const call = await session.callTool("list_tasks", { project: PROJECT_KEY, ...args });
    accepted(call);
    return keysOf(call);
  };

  expect(await list({ fields: { Difficulty: "L" } })).toEqual([large.key]);
  expect(await list({ fields: { difficulty: "S" } })).toEqual([small.key]);
  // A multiselect needs every option asked for, and a checkbox nobody ticked is "No"
  expect(await list({ fields: { Platforms: ["iOS"] } })).toEqual([large.key]);
  expect(await list({ fields: { Platforms: ["iOS", "Web"] } })).toEqual([large.key]);
  expect(await list({ fields: { "Spike?": true } })).toEqual([large.key]);
  const unticked = await list({ fields: { "Spike?": false } });
  expect(unticked).not.toContain(large.key);
  expect(unticked).toEqual(expect.arrayContaining([small.key, plain.key]));
  expect(await list({ sprint: "hardening" })).toEqual([large.key]);
  expect(await list({ sprint: "backlog" })).not.toContain(large.key);
  expect(await list({ search: "needle" })).toEqual([large.key]);

  // The end day is included, and a task with no due date is in no range
  expect(await list({ dueBefore: "2026-10-10" })).toEqual([small.key]);
  expect(await list({ dueAfter: "2026-10-10" })).toEqual([small.key]);
  expect(await list({ dueBefore: "2026-10-09" })).toEqual([]);
  expect(await list({ dueAfter: "2026-10-11" })).toEqual([]);

  accepted(await session.callTool("link_tasks", { taskKey: large.key, targetTaskKey: small.key, type: "parent_of" }));
  accepted(await session.callTool("link_tasks", { taskKey: plain.key, targetTaskKey: large.key, type: "blocked_by" }));
  expect(await list({ parent: large.key })).toEqual([small.key]);
  expect(await list({ blocked: true })).toEqual([plain.key]);
  expect(await list({ blocked: false })).not.toContain(plain.key);
  const children = await session.callTool("list_tasks", { project: PROJECT_KEY, sprint: "backlog", parent: large.key });
  expect(children.parsed.tasks[0]).toMatchObject({ key: small.key, parent: large.key });

  // updatedSince: everything this test touched is newer than a day ago, and nothing is newer than tomorrow
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  expect(await list({ updatedSince: "2020-01-01" })).toEqual(expect.arrayContaining([large.key, small.key, plain.key]));
  expect(await list({ updatedSince: tomorrow })).toEqual([]);
});

test("list_tasks refuses a filter that names nothing the board has, rather than answering an empty list", async ({ request }) => {
  await seedCustomFields();
  const session = await connected(request);

  const noSprint = await session.callTool("list_tasks", { project: PROJECT_KEY, sprint: "Nowhere" });
  refused(noSprint);
  expect(noSprint.text).toContain('No sprint "Nowhere"');

  const noField = await session.callTool("list_tasks", { project: PROJECT_KEY, fields: { Colour: "red" } });
  refused(noField);
  expect(noField.text).toContain('Unknown field "Colour"');

  const badDay = await session.callTool("list_tasks", { project: PROJECT_KEY, dueBefore: "next week" });
  refused(badDay);
  expect(badDay.text).toContain("Invalid dueBefore");

  const tooMany = await session.callTool("list_tasks", { project: PROJECT_KEY, limit: 500 });
  refused(tooMany);
});

/**
 * BP-911. A sprint is read with its tasks, closed with its unfinished work carried somewhere, and
 * deleted — each checked against what the API holds afterwards, since a reply can be right about a
 * move that did not happen.
 */
test("a sprint is read with its tasks, completed with its unfinished work carried on, and deleted", async ({ request }) => {
  await seedSecondProject();
  await seedForeignSprint();
  const session = await connected(request);
  const sprint = async (name: string, startDate: string, endDate: string) => {
    const made = await session.callTool("create_sprint", { project: PROJECT_KEY, name, startDate, endDate });
    accepted(made);
    return made.parsed._id as string;
  };
  const alpha = await sprint("Alpha", "2026-10-01", "2026-10-14");
  const beta = await sprint("Beta", "2026-10-15", "2026-10-28");

  const file = async (title: string) => {
    const created = await session.callTool("create_task", { project: PROJECT_KEY, title });
    accepted(created);
    return { key: `${PROJECT_KEY}-${created.parsed.taskNumber}`, id: created.parsed._id as string };
  };
  const [one, two, three] = [await file("One"), await file("Two"), await file("Three")];
  const put = (id: string, data: Record<string, unknown>) =>
    request.put(`/api/projects/${PROJECT_ID}/tasks/${id}`, { headers: ADMIN_AUTH, data });
  for (const task of [one, two, three]) expect((await put(task.id, { sprint: alpha })).status()).toBe(200);
  accepted(await session.callTool("change_task_status", { taskKey: three.key, status: "done" }));
  const sprintOf = async (id: string) => {
    const stored = await (await request.get(`/api/projects/${PROJECT_ID}/tasks/${id}`, { headers: ADMIN_AUTH })).json();
    return stored.sprint ? String(stored.sprint._id ?? stored.sprint) : null;
  };

  // Read by name: its counts, its tasks as lines, a page at a time
  const read = await session.callTool("get_sprint", { project: PROJECT_KEY, sprint: "alpha", limit: 2 });
  accepted(read);
  expect(read.parsed.sprint).toMatchObject({ id: alpha, name: "Alpha", taskCount: 3, doneCount: 1, startDate: "2026-10-01" });
  expect(read.parsed).toMatchObject({ total: 3, returned: 2, nextOffset: 2 });
  const rest = await session.callTool("get_sprint", { project: PROJECT_KEY, sprint: alpha, limit: 2, offset: 2 });
  const keys = [...(read.parsed.tasks as { key: string }[]), ...(rest.parsed.tasks as { key: string }[])].map((t) => t.key);
  expect(keys.sort()).toEqual([one.key, two.key, three.key].sort());
  expect(rest.parsed.nextOffset).toBeNull();

  // Refused before anything moves: the wrong destination, and a move without a completion
  for (const [args, said] of [
    [{ status: "completed", moveIncomplete: "Alpha" }, "own destination"],
    [{ status: "completed", moveIncomplete: "Nowhere" }, 'No sprint "Nowhere"'],
    [{ goal: "x", moveIncomplete: "backlog" }, "goes with status completed"],
  ] as const) {
    const refusedCall = await session.callTool("update_sprint", { project: PROJECT_KEY, sprintId: "Alpha", ...args });
    refused(refusedCall);
    expect(refusedCall.text).toContain(said);
  }
  expect(await sprintOf(one.id)).toBe(alpha);

  // Completed by name: the two unfinished tasks move to Beta, the finished one stays where it was done
  accepted(await session.callTool("update_sprint", { project: PROJECT_KEY, sprintId: "Alpha", status: "completed", moveIncomplete: "Beta" }));
  expect(await sprintOf(one.id)).toBe(beta);
  expect(await sprintOf(two.id)).toBe(beta);
  expect(await sprintOf(three.id)).toBe(alpha);

  // A completed sprint is not a destination
  const closed = await session.callTool("update_sprint", { project: PROJECT_KEY, sprintId: "Beta", status: "completed", moveIncomplete: "Alpha" });
  refused(closed);
  expect(closed.text).toContain("is completed");

  // Deleting needs the name repeated, sends every task back to the backlog, and leaves the tasks themselves
  const wrongName = await session.callTool("delete_sprint", { project: PROJECT_KEY, sprint: "Beta", confirmName: "Alpha" });
  refused(wrongName);
  expect(await sprintOf(one.id)).toBe(beta);
  const deleted = await session.callTool("delete_sprint", { project: PROJECT_KEY, sprint: "Beta", confirmName: "beta" });
  accepted(deleted);
  expect(deleted.parsed).toEqual({ deleted: "Beta", id: beta, tasksReturnedToBacklog: 2 });
  expect(await sprintOf(one.id)).toBeNull();
  expect(await sprintOf(two.id)).toBeNull();
  const sprints = await session.callTool("list_sprints", { project: PROJECT_KEY });
  expect((sprints.parsed as { name: string }[]).map((s) => s.name)).toEqual(["Alpha"]);

  // Another board's sprint is out of reach for all three
  for (const call of [
    session.callTool("get_sprint", { project: PROJECT_KEY, sprint: String(FOREIGN_SPRINT_ID) }),
    session.callTool("delete_sprint", { project: PROJECT_KEY, sprint: String(FOREIGN_SPRINT_ID), confirmName: FOREIGN_SPRINT_NAME }),
    session.callTool("update_sprint", { project: PROJECT_KEY, sprintId: String(FOREIGN_SPRINT_ID), goal: "mine now" }),
  ]) {
    const result = await call;
    refused(result);
    expect(result.text).toContain("No sprint");
  }
  expect((await storedSprint(FOREIGN_SPRINT_ID))?.name).toBe(FOREIGN_SPRINT_NAME);
});

test("a sprint name two sprints share is refused with their ids, by every tool that acts on one", async ({ request }) => {
  const session = await connected(request);
  const first = await session.callTool("create_sprint", { project: PROJECT_KEY, name: "Twin", startDate: "2026-10-01", endDate: "2026-10-07" });
  const second = await session.callTool("create_sprint", { project: PROJECT_KEY, name: "Twin", startDate: "2026-10-08", endDate: "2026-10-14" });
  accepted(first);
  accepted(second);

  for (const call of [
    session.callTool("get_sprint", { project: PROJECT_KEY, sprint: "Twin" }),
    session.callTool("update_sprint", { project: PROJECT_KEY, sprintId: "Twin", goal: "which?" }),
    session.callTool("delete_sprint", { project: PROJECT_KEY, sprint: "Twin", confirmName: "Twin" }),
  ]) {
    const result = await call;
    refused(result);
    expect(result.text).toContain('2 sprints are named "Twin"');
    expect(result.text).toContain(first.parsed._id);
    expect(result.text).toContain(second.parsed._id);
  }
  // By id it is exact, and only that one goes
  accepted(await session.callTool("delete_sprint", { project: PROJECT_KEY, sprint: first.parsed._id, confirmName: "Twin" }));
  expect(((await session.callTool("list_sprints", { project: PROJECT_KEY })).parsed as { _id: string }[]).map((s) => s._id)).toEqual([second.parsed._id]);
});

/**
 * BP-905. The task carried a due date, a sprint and a recurrence an agent could read and not write.
 * Each write ends on what the API stores afterwards, and the clearing is asserted too — a field that
 * can be set and not unset is a trap.
 */
async function apiTask(request: APIRequestContext, taskId: string) {
  const response = await request.get(`/api/projects/${PROJECT_ID}/tasks/${taskId}`, { headers: ADMIN_AUTH });
  expect(response.status()).toBe(200);
  return response.json();
}

test("create_task and update_task set a due date, a sprint and a recurrence, and clear them again", async ({ request }) => {
  await seedSecondProject();
  await seedForeignSprint();
  const session = await connected(request);

  const sprint = await session.callTool("create_sprint", {
    project: PROJECT_KEY,
    name: "Hardening",
    startDate: "2026-10-01",
    endDate: "2026-10-14",
  });
  accepted(sprint);

  const created = await session.callTool("create_task", {
    project: PROJECT_KEY,
    title: "Dated and repeating",
    dueDate: "2026-10-10",
    sprint: "hardening",
    recurrence: { frequency: "weekly", interval: 2, endDate: "2026-12-31" },
  });
  accepted(created);
  const key = `${PROJECT_KEY}-${created.parsed.taskNumber}`;
  const taskId: string = created.parsed._id;

  const stored = await apiTask(request, taskId);
  expect(stored.dueDate).toMatch(/^2026-10-10/);
  expect(String(stored.sprint?._id ?? stored.sprint)).toBe(sprint.parsed._id);
  expect(stored.recurrence).toMatchObject({ frequency: "weekly", interval: 2 });
  expect(stored.recurrence.endDate).toMatch(/^2026-12-31/);

  // Moved to another sprint and another day
  const second = await session.callTool("create_sprint", {
    project: PROJECT_KEY,
    name: "Next",
    startDate: "2026-10-15",
    endDate: "2026-10-28",
  });
  accepted(second);
  accepted(await session.callTool("update_task", { taskKey: key, dueDate: "2026-11-02", sprint: "Next" }));
  const moved = await apiTask(request, taskId);
  expect(moved.dueDate).toMatch(/^2026-11-02/);
  expect(String(moved.sprint?._id ?? moved.sprint)).toBe(second.parsed._id);

  // Each one clears
  accepted(await session.callTool("update_task", { taskKey: key, dueDate: "", sprint: "backlog", recurrence: null }));
  const cleared = await apiTask(request, taskId);
  expect(cleared.dueDate).toBeNull();
  expect(cleared.sprint).toBeNull();
  expect(cleared.recurrence).toBeNull();

  // Refused before anything is written: another board's sprint, a day that does not exist, a series the route would refuse
  const foreign = await session.callTool("update_task", { taskKey: key, sprint: String(FOREIGN_SPRINT_ID) });
  refused(foreign);
  expect(foreign.text).toContain(`No sprint "${FOREIGN_SPRINT_ID}"`);
  const impossible = await session.callTool("update_task", { taskKey: key, dueDate: "2026-02-31" });
  refused(impossible);
  expect(impossible.text).toContain("Invalid dueDate");
  // ...and a series the schema refuses, or one with a key it does not know (which would otherwise be dropped)
  for (const recurrence of [
    { frequency: "yearly", interval: 1 },
    { frequency: "daily", interval: 1, until: "2026-12-31" },
  ]) {
    const never = await session.callTool("update_task", { taskKey: key, recurrence });
    expect(never.raw.error?.message ?? never.raw.result?.isError, never.text).toBeTruthy();
  }
  const untouched = await apiTask(request, taskId);
  expect(untouched.sprint).toBeNull();
  expect(untouched.dueDate).toBeNull();

  // A name two sprints share is refused with their ids; a completed sprint is refused outright
  accepted(await session.callTool("create_sprint", { project: PROJECT_KEY, name: "Hardening", startDate: "2026-11-01", endDate: "2026-11-14" }));
  const twin = await session.callTool("update_task", { taskKey: key, sprint: "Hardening" });
  refused(twin);
  expect(twin.text).toContain('2 sprints are named "Hardening"');
  expect(twin.text).toContain(String(sprint.parsed._id));
  accepted(await session.callTool("update_sprint", { project: PROJECT_KEY, sprintId: second.parsed._id, status: "completed" }));
  const closed = await session.callTool("update_task", { taskKey: key, sprint: "Next" });
  refused(closed);
  expect(closed.text).toContain('Sprint "Next" is completed');
  expect((await apiTask(request, taskId)).sprint).toBeNull();

  // A create naming another board's sprint is refused rather than answered 200 for a task in no sprint
  const strayed = await session.callTool("create_task", {
    project: PROJECT_KEY,
    title: "Never made",
    sprint: String(FOREIGN_SPRINT_ID),
  });
  refused(strayed);
});

test("watch_task and unwatch_task are idempotent and show on the task", async ({ request }) => {
  const session = await connected(request);
  const created = await session.callTool("create_task", { project: PROJECT_KEY, title: "Watched" });
  accepted(created);
  const key = `${PROJECT_KEY}-${created.parsed.taskNumber}`;
  const taskId: string = created.parsed._id;
  const me = (await (await request.get("/api/auth/me", { headers: ADMIN_AUTH })).json()) as { _id: string };
  const watchers = async () => ((await apiTask(request, taskId)).watchers as unknown[]).map((w) => String((w as { _id?: string })?._id ?? w));

  // Twice each: a retried flip would undo itself
  for (let attempt = 0; attempt < 2; attempt++) {
    const on = await session.callTool("watch_task", { taskKey: key });
    accepted(on);
    expect(on.parsed).toEqual({ taskKey: key, watching: true });
    expect(await watchers()).toEqual([me._id]);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const off = await session.callTool("unwatch_task", { taskKey: key });
    accepted(off);
    expect(off.parsed).toEqual({ taskKey: key, watching: false });
    expect(await watchers()).toEqual([]);
  }
});

/**
 * BP-908. A checklist is read back from the API after each call, because the reply is the one thing a
 * write that stored nothing can still get right. What matters is what happens to the items that were
 * not touched: their ids, which the history and a worker's tick are keyed on, and their ticks.
 */
test("one checklist item is added, ticked, reworded and removed without disturbing the others", async ({ request }) => {
  const session = await connected(request);
  const created = await session.callTool("create_task", {
    project: PROJECT_KEY,
    title: "With a checklist",
    acceptanceCriteria: "- [x] first\n- [ ] second\n- [ ] third",
  });
  accepted(created);
  const key = `${PROJECT_KEY}-${created.parsed.taskNumber}`;
  const taskId: string = created.parsed._id;
  const items = async () => ((await storedApiTask(request, taskId)).checklist as { _id: string; text: string; done: boolean }[]);

  const [first, second, third] = await items();
  expect([first.done, second.done, third.done]).toEqual([true, false, false]);

  // Added at the end, the others exactly as they were
  const added = await session.callTool("add_checklist_item", { taskKey: key, text: "fourth" });
  accepted(added);
  let now = await items();
  expect(now.map((i) => [i._id, i.text, i.done])).toEqual([
    [first._id, "first", true],
    [second._id, "second", false],
    [third._id, "third", false],
    [now[3]._id, "fourth", false],
  ]);
  const fourthId = now[3]._id;
  expect(added.parsed.checklist[3]).toEqual({ id: fourthId, text: "fourth", done: false });

  // Ticked by its text, then reworded by its id; the neighbours keep their ids and their state
  const ticked = await session.callTool("set_checklist_item", { taskKey: key, item: "SECOND", done: true });
  accepted(ticked);
  // The answer names every item with its id and its state as stored — not the internals of a document
  expect(ticked.parsed.checklist).toEqual([
    { id: first._id, text: "first", done: true },
    { id: second._id, text: "second", done: true },
    { id: third._id, text: "third", done: false },
    { id: expect.stringMatching(/^[0-9a-f]{24}$/), text: "fourth", done: false },
  ]);
  const reworded = await session.callTool("set_checklist_item", { taskKey: key, item: third._id, text: "third, reworded" });
  accepted(reworded);
  expect(reworded.parsed.checklist[2]).toEqual({ id: third._id, text: "third, reworded", done: false });
  now = await items();
  expect(now.map((i) => [i._id, i.text, i.done])).toEqual([
    [first._id, "first", true],
    [second._id, "second", true],
    [third._id, "third, reworded", false],
    [fourthId, "fourth", false],
  ]);

  // The history says what happened, as it does when a person ticks the box
  const activity = JSON.stringify(await (await request.get(`/api/projects/${PROJECT_ID}/tasks/${taskId}/activity`, { headers: ADMIN_AUTH })).json());
  expect(activity).toContain("criterion_checked");
  expect(activity).toContain("criterion_edited");
  expect(activity).toContain("criterion_added");
  // ...and nothing it did not do: a tick is not an edit, and a reword is not an untick
  expect(activity.match(/criterion_edited/g)).toHaveLength(1);
  expect(activity).not.toContain("criterion_unchecked");
  expect(activity).not.toContain("undefined");

  // Resending the list as plain lines, one of them reworded, keeps the id and tick of every other line
  accepted(
    await session.callTool("update_task", { taskKey: key, acceptanceCriteria: "first\nsecond\nthird, reworded again\nfourth" })
  );
  now = await items();
  expect(now.map((i) => [i._id, i.text, i.done])).toEqual([
    [first._id, "first", true],
    [second._id, "second", true],
    [expect.not.stringMatching(third._id), "third, reworded again", false],
    [fourthId, "fourth", false],
  ]);

  accepted(await session.callTool("remove_checklist_item", { taskKey: key, item: "fourth" }));
  expect((await items()).map((i) => i.text)).toEqual(["first", "second", "third, reworded again"]);

  // An item that is not there is refused, and nothing is written
  const before = JSON.stringify(await items());
  const missing = await session.callTool("set_checklist_item", { taskKey: key, item: "fifth", done: true });
  refused(missing);
  expect(missing.text).toContain('No criterion "fifth"');
  expect(JSON.stringify(await items())).toBe(before);
});

test("ticks made at the same moment all land: one criterion changes, not the whole list", async ({ request }) => {
  const session = await connected(request);
  const created = await session.callTool("create_task", {
    project: PROJECT_KEY,
    title: "Ticked all at once",
    acceptanceCriteria: Array.from({ length: 8 }, (_, i) => `- [ ] criterion ${i + 1}`).join("\n"),
  });
  accepted(created);
  const key = `${PROJECT_KEY}-${created.parsed.taskNumber}`;
  const ids = (created.parsed.checklist as { _id: string }[]).map((c) => c._id);

  // A list written back whole would let each call overwrite the ticks the others made in between
  const answers = await Promise.all(ids.map((id) => session.callTool("set_checklist_item", { taskKey: key, item: id, done: true })));
  for (const answer of answers) accepted(answer);

  const stored = (await storedApiTask(request, created.parsed._id)).checklist as { done: boolean }[];
  expect(stored.map((c) => c.done)).toEqual(ids.map(() => true));
  const activity = JSON.stringify(await (await request.get(`/api/projects/${PROJECT_ID}/tasks/${created.parsed._id}/activity`, { headers: ADMIN_AUTH })).json());
  expect(activity.match(/criterion_checked/g)).toHaveLength(ids.length);
});

test("an item two criteria share is refused with their ids rather than guessed", async ({ request }) => {
  const session = await connected(request);
  const created = await session.callTool("create_task", {
    project: PROJECT_KEY,
    title: "Twins",
    acceptanceCriteria: "- [ ] same\n- [ ] same",
  });
  accepted(created);
  const key = `${PROJECT_KEY}-${created.parsed.taskNumber}`;
  const ids = (created.parsed.checklist as { _id: string }[]).map((c) => c._id);

  const ambiguous = await session.callTool("set_checklist_item", { taskKey: key, item: "same", done: true });
  refused(ambiguous);
  expect(ambiguous.text).toContain('2 criteria read "same"');
  for (const id of ids) expect(ambiguous.text).toContain(id);

  // By id it is exact
  accepted(await session.callTool("set_checklist_item", { taskKey: key, item: ids[1], done: true }));
  const stored = (await storedApiTask(request, created.parsed._id)).checklist as { _id: string; done: boolean }[];
  expect(stored.map((c) => [c._id, c.done])).toEqual([[ids[0], false], [ids[1], true]]);
});

async function storedApiTask(request: APIRequestContext, taskId: string) {
  const response = await request.get(`/api/projects/${PROJECT_ID}/tasks/${taskId}`, { headers: ADMIN_AUTH });
  expect(response.status()).toBe(200);
  return response.json();
}

/**
 * BP-910. create_task and update_task refuse an assignee who is not on the board and nothing said who
 * is; update_task names an agent and nothing listed them. Each answer is checked against what the
 * API itself says, and against what it must not say.
 */
test("list_members and whoami say who the board has and who is asking, and nothing more about them", async ({ request }) => {
  const session = await connected(request);

  const members = await session.callTool("list_members", { project: PROJECT_KEY });
  accepted(members);
  const roster = (await (await request.get(`/api/projects/${PROJECT_ID}/assignable-users`, { headers: ADMIN_AUTH })).json()) as {
    username: string;
  }[];
  expect((members.parsed as { username: string }[]).map((m) => m.username)).toEqual(roster.map((r) => r.username));
  expect(members.parsed.map((m: { username: string }) => m.username)).toEqual(expect.arrayContaining([ADMIN_USERNAME, MEMBER_USERNAME]));
  for (const member of members.parsed) expect(Object.keys(member).sort()).toEqual(["fullName", "username"]);

  // A name on the list is one assignee takes
  accepted(await session.callTool("update_task", { taskKey: SIBLING_TASK_KEY, assignee: members.parsed[0].username }));

  const me = await session.callTool("whoami");
  accepted(me);
  expect(me.parsed).toEqual({ username: ADMIN_USERNAME, fullName: expect.any(String), role: "admin" });

  // Another board is not this caller's to read
  await seedSecondProject();
  const member = await connected(request, MEMBER_API_TOKEN);
  const refusedBoard = await member.callTool("list_members", { project: SECOND_PROJECT_KEY });
  refused(refusedBoard);
});

test("my_tasks lists the caller's own open work by key, and finished work only when asked", async ({ request }) => {
  const session = await connected(request);
  const open = await session.callTool("create_task", { project: PROJECT_KEY, title: "Mine, open", assignee: ADMIN_USERNAME });
  const shipped = await session.callTool("create_task", { project: PROJECT_KEY, title: "Mine, shipped", assignee: ADMIN_USERNAME });
  const theirs = await session.callTool("create_task", { project: PROJECT_KEY, title: "Somebody else's", assignee: MEMBER_USERNAME });
  for (const made of [open, shipped, theirs]) accepted(made);
  accepted(await session.callTool("change_task_status", { taskKey: `${PROJECT_KEY}-${shipped.parsed.taskNumber}`, status: "done" }));

  const mine = await session.callTool("my_tasks");
  accepted(mine);
  const keys = (mine.parsed.tasks as { key: string }[]).map((t) => t.key);
  expect(keys).toContain(`${PROJECT_KEY}-${open.parsed.taskNumber}`);
  expect(keys).not.toContain(`${PROJECT_KEY}-${shipped.parsed.taskNumber}`);
  expect(keys).not.toContain(`${PROJECT_KEY}-${theirs.parsed.taskNumber}`);
  expect(mine.parsed).toMatchObject({ returned: keys.length, total: keys.length, nextOffset: null });

  const everything = await session.callTool("my_tasks", { includeDone: true });
  expect((everything.parsed.tasks as { key: string }[]).map((t) => t.key)).toContain(`${PROJECT_KEY}-${shipped.parsed.taskNumber}`);

  const paged = await session.callTool("my_tasks", { includeDone: true, limit: 1 });
  expect(paged.parsed).toMatchObject({ returned: 1, nextOffset: 1 });
  expect(paged.parsed.total).toBe(everything.parsed.total);
});

test("list_agents offers what update_task can choose on the board, and not another board's agent", async ({ request }) => {
  await seedSecondProject();
  await seedAgents();
  await seedForeignAgent();
  const session = await connected(request);

  const agents = await session.callTool("list_agents", { project: PROJECT_KEY });
  accepted(agents);
  const names = (agents.parsed as { name: string }[]).map((a) => a.name);
  expect(names).toContain(PROJECT_AGENT_NAME);
  expect(names).not.toContain(FOREIGN_ONLY_AGENT_NAME);
  for (const agent of agents.parsed) {
    expect(Object.keys(agent).sort()).toEqual(["description", "name", "scope", "steps"]);
    expect(agent.steps).toBeGreaterThanOrEqual(0);
  }

  // Every name listed is one update_task takes
  accepted(await session.callTool("update_task", { taskKey: SIBLING_TASK_KEY, agent: PROJECT_AGENT_NAME }));
});

/**
 * BP-912. A comment is corrected and removed by the person who wrote it — the API's rule, which these
 * tools do not widen — and the history is read back as the task page shows it. Each write ends on the
 * comment as the page reads it, not on the reply.
 */
test("a comment is edited and deleted by its author, and refused to anybody else", async ({ request }) => {
  const session = await connected(request);
  const added = await session.callTool("add_comment", { taskKey: SIBLING_TASK_KEY, body: "First draft" });
  accepted(added);
  const id: string = added.parsed._id;
  const stored = async () =>
    ((await (await request.get(`/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}/comments`, { headers: ADMIN_AUTH })).json()) as { _id: string; body: string }[]);

  const listed = await session.callTool("list_comments", { taskKey: SIBLING_TASK_KEY });
  accepted(listed);
  expect(listed.parsed.comments).toEqual([
    expect.objectContaining({ id, author: ADMIN_USERNAME, body: "First draft", reactions: [] }),
  ]);

  const edited = await session.callTool("edit_comment", { taskKey: SIBLING_TASK_KEY, commentId: id, body: "Second draft" });
  accepted(edited);
  expect(edited.parsed).toMatchObject({ id, body: "Second draft", author: ADMIN_USERNAME });
  expect((await stored()).map((c) => c.body)).toEqual(["Second draft"]);

  // A blank text is refused as the API refuses it, and the comment keeps what it had
  const blank = await session.callTool("edit_comment", { taskKey: SIBLING_TASK_KEY, commentId: id, body: "  " });
  refused(blank);
  expect(blank.text).toContain("Comment body is required");
  expect((await stored()).map((c) => c.body)).toEqual(["Second draft"]);

  // Somebody else's comment is theirs: the member may neither edit nor delete it
  const member = await connected(request, MEMBER_API_TOKEN);
  const notYours = await member.callTool("edit_comment", { taskKey: SIBLING_TASK_KEY, commentId: id, body: "Hijacked" });
  refused(notYours);
  expect(notYours.text).toContain("Forbidden");
  const notDeleted = await member.callTool("delete_comment", { taskKey: SIBLING_TASK_KEY, commentId: id });
  refused(notDeleted);
  expect((await stored()).map((c) => c.body)).toEqual(["Second draft"]);

  // A comment that is not there
  const gone = await session.callTool("edit_comment", { taskKey: SIBLING_TASK_KEY, commentId: "507f1f77bcf86cd7994399ff", body: "x" });
  refused(gone);
  expect(gone.text).toContain("Comment not found");

  const deleted = await session.callTool("delete_comment", { taskKey: SIBLING_TASK_KEY, commentId: id });
  accepted(deleted);
  expect(deleted.parsed).toEqual({ deleted: id, taskKey: SIBLING_TASK_KEY });
  expect(await stored()).toEqual([]);
});

test("list_comments pages through a long thread without a comment twice or missing", async ({ request }) => {
  const session = await connected(request);
  const bodies = Array.from({ length: 7 }, (_, i) => `note ${i + 1}`);
  for (const body of bodies) accepted(await session.callTool("add_comment", { taskKey: SIBLING_TASK_KEY, body }));

  const seen: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page: ToolCall = await session.callTool("list_comments", { taskKey: SIBLING_TASK_KEY, limit: 3, offset });
    accepted(page);
    expect(page.parsed.total).toBe(7);
    seen.push(...(page.parsed.comments as { body: string }[]).map((c) => c.body));
    offset = page.parsed.nextOffset;
  }
  expect(seen).toEqual(bodies);
});

test("get_task_activity reads what changed, newest first, and who changed it", async ({ request }) => {
  const session = await connected(request);
  const created = await session.callTool("create_task", { project: PROJECT_KEY, title: "Before" });
  accepted(created);
  const key = `${PROJECT_KEY}-${created.parsed.taskNumber}`;
  accepted(await session.callTool("update_task", { taskKey: key, title: "After", priority: "high" }));
  accepted(await session.callTool("change_task_status", { taskKey: key, status: "in_progress" }));

  const history = await session.callTool("get_task_activity", { taskKey: key });
  accepted(history);
  const entries = history.parsed.entries as { by: string; action: string; field: string | null; from: string; to: string; at: string }[];
  expect(history.parsed.total).toBe(entries.length);
  // Newest first: the status move, then the edits, then the creation
  expect(entries[0]).toMatchObject({ by: ADMIN_USERNAME, action: "status_changed", field: "status", to: "in_progress" });
  expect(entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: "updated", field: "title", from: "Before", to: "After" }),
      expect.objectContaining({ action: "updated", field: "priority", to: "high" }),
      expect.objectContaining({ action: "created", by: ADMIN_USERNAME }),
    ])
  );
  expect(entries.at(-1)!.action).toBe("created");

  // A description is said to be added, edited or removed — never given back as text, never mistaken for cleared
  accepted(await session.callTool("update_task", { taskKey: key, description: "first words" }));
  accepted(await session.callTool("update_task", { taskKey: key, description: "other words" }));
  const withDescription = (await session.callTool("get_task_activity", { taskKey: key })).parsed.entries as { field: string; from: string; to: string }[];
  const described = withDescription.filter((e) => e.field === "description");
  // Two edits in a row by one person read as one entry, the way the task page folds them: the net change is an addition
  expect(described.map((e) => [e.from, e.to])).toEqual([["", "(added)"]]);
  expect(JSON.stringify(described)).not.toContain("words");
  const times = entries.map((e) => e.at);
  expect([...times].sort().reverse()).toEqual(times);
  expect((await session.callTool("get_task_activity", { taskKey: key, limit: 1 })).parsed.entries).toHaveLength(1);
});

/**
 * BP-913. What a person reads daily and an MCP client could not: a search across boards, a board's
 * numbers, the runs workers made, and the bell. Each answer is checked against what the API says or
 * against what the test itself caused.
 */
test("search_tasks finds a task by key and by text, across the boards the caller can reach", async ({ request }) => {
  await seedSecondProject();
  await seedDemotableAdmin();
  const session = await connected(request);
  const mine = await session.callTool("create_task", { project: PROJECT_KEY, title: "A needle in the first board" });
  accepted(mine);
  const key = `${PROJECT_KEY}-${mine.parsed.taskNumber}`;

  const byKey = await session.callTool("search_tasks", { query: key });
  accepted(byKey);
  expect(byKey.parsed.tasks).toEqual([expect.objectContaining({ key, title: "A needle in the first board", project: PROJECT_NAME })]);

  const byText = await session.callTool("search_tasks", { query: "needle" });
  expect((byText.parsed.tasks as { key: string }[]).map((t) => t.key)).toEqual([key]);

  // Across boards: the second board's one task is found by its own text, which list_tasks on this board cannot do
  const other = await session.callTool("search_tasks", { query: KEPT_TASK_TITLE.slice(0, 8) });
  expect((other.parsed.tasks as { key: string }[]).map((t) => t.key)).toContain(KEPT_TASK_KEY);

  // A member reaches only their own boards' tasks
  const member = await connected(request, MEMBER_API_TOKEN);
  const memberHits = await member.callTool("search_tasks", { query: KEPT_TASK_TITLE.slice(0, 8) });
  expect((memberHits.parsed.tasks as { key: string }[]).map((t) => t.key)).not.toContain(KEPT_TASK_KEY);

  const tooShort = await session.callTool("search_tasks", { query: "a" });
  expect(tooShort.raw.error?.message ?? tooShort.raw.result?.isError).toBeTruthy();
});

test("get_project_stats reports the same numbers the stats route does, without its per-field table", async ({ request }) => {
  const session = await connected(request);
  const route = (await (await request.get(`/api/projects/${PROJECT_ID}/stats`, { headers: ADMIN_AUTH })).json()) as Record<string, unknown>;

  const stats = await session.callTool("get_project_stats", { project: PROJECT_KEY });
  accepted(stats);
  expect(stats.parsed).toMatchObject({ total: route.total, done: route.done, statusBreakdown: route.statusBreakdown, velocity: route.velocity });
  expect(stats.parsed).not.toHaveProperty("customFieldUsage");
  expect(stats.parsed.total).toBeGreaterThan(0);
});

test("list_runs reads the runs on a board, newest first", async ({ request }) => {
  await seedRuns();
  const session = await connected(request);

  const runs = await session.callTool("list_runs", { project: PROJECT_KEY });
  accepted(runs);
  expect(runs.parsed).toHaveLength(2);
  expect(runs.parsed[0]).toMatchObject({ taskKey: RUN_TASK_KEY, outcome: "refused", refusedBy: "review-gate", detail: "the diff is too large" });
  expect(runs.parsed[1]).toMatchObject({ outcome: "delivered", costUsd: 1.5, agent: "Default", minutes: 12 });
  expect((await session.callTool("list_runs", { project: PROJECT_KEY, limit: 1 })).parsed).toHaveLength(1);

  // Run history is for a board's admins, as the app has it: a member's token is refused, not shown it
  const member = await connected(request, MEMBER_API_TOKEN);
  const notAdmin = await member.callTool("list_runs", { project: PROJECT_KEY });
  refused(notAdmin);
  expect(notAdmin.text).toContain("Run history is for the admins");
});

test("list_notifications and mark_notifications_read work on the caller's own bell", async ({ request }) => {
  const admin = await connected(request);
  const member = await connected(request, MEMBER_API_TOKEN);
  // Handing the member a task is what puts a row on their bell
  for (const taskKey of [SIBLING_TASK_KEY, HELD_TASK_KEY]) {
    accepted(await admin.callTool("update_task", { taskKey, assignee: MEMBER_USERNAME }));
  }

  const bell = await member.callTool("list_notifications");
  accepted(bell);
  expect(bell.parsed.unreadOnPage).toBeGreaterThanOrEqual(1);
  const [first] = bell.parsed.notifications as { id: string; read: boolean; by: string; task: string | null }[];
  expect(first).toMatchObject({ read: false, by: ADMIN_USERNAME });
  expect(first.task).toMatch(new RegExp(`^${PROJECT_KEY}-\\d+$`));

  // One by its id, and only that one
  accepted(await member.callTool("mark_notifications_read", { id: first.id }));
  const after = (await member.callTool("list_notifications")).parsed.notifications as { id: string; read: boolean }[];
  expect(after.find((n) => n.id === first.id)!.read).toBe(true);
  expect(after.some((n) => !n.read)).toBe(true);

  // Then all of them
  accepted(await member.callTool("mark_notifications_read"));
  expect((await member.callTool("list_notifications")).parsed.unreadOnPage).toBe(0);

  // A page is a page: one row, and a cursor to the next while more remain
  const paged = await member.callTool("list_notifications", { limit: 1 });
  expect(paged.parsed.returned).toBe(1);
  expect(paged.parsed.nextBefore).toBeTruthy();
  // The cursor leads to the other row, not back to this one
  const older = await member.callTool("list_notifications", { limit: 1, before: paged.parsed.nextBefore });
  accepted(older);
  expect((older.parsed.notifications as { id: string }[]).map((n) => n.id)).not.toContain(paged.parsed.notifications[0].id);

  // A cursor that is not a time is refused as such
  const garbled = await member.callTool("list_notifications", { before: "last week" });
  expect(garbled.raw.error?.message ?? garbled.text).toContain("timestamp");
});

/**
 * BP-909. A board seeded in a few calls instead of a few hundred. Everything is read back from the board
 * afterwards — the replies are the one thing a batch that stored nothing can still get right.
 */
test("create_tasks builds an epic with its sub-tasks and blockers in one call, and says which items failed", async ({ request }) => {
  const session = await connected(request);
  const answer = await session.callTool("create_tasks", {
    project: PROJECT_KEY,
    tasks: [
      { title: "Epic", description: "the parent", priority: "high" },
      { title: "Child one", parent: "#1", acceptanceCriteria: "- [ ] done well" },
      { title: "Child two", parent: "#1", blockedBy: ["#2"] },
      { title: "Wrong category", category: "chore", parent: "#1" },
      { title: "Child of a task that was never made", parent: "#4" },
      { title: "Blocked by an existing one", blockedBy: [SIBLING_TASK_KEY] },
      { title: "Bad link", parent: "TP-9999" },
    ],
  });
  accepted(answer);
  expect(answer.parsed).toMatchObject({ requested: 7, created: 5, failed: 2 });
  const rows = answer.parsed.results as { n: number; key?: string; error?: string; linkErrors?: string[] }[];
  const key = (n: number) => rows[n - 1].key!;
  expect(rows.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(rows[3].error).toContain('Invalid category "chore"');
  expect(rows[4].error).toMatch(/#4 did not create a task/);
  expect(rows[6].key).toBeTruthy();
  expect(rows[6].linkErrors?.[0]).toContain("TP-9999");

  // What the board holds: the epic has its two children, the second child is blocked by the first
  const epic = await session.callTool("get_task", { taskKey: key(1) });
  expect(epic.parsed).toMatchObject({ title: "Epic", description: "the parent", priority: "high" });
  expect((epic.parsed.children as { key: string }[]).map((c) => c.key).sort()).toEqual([key(2), key(3)].sort());
  const second = await session.callTool("get_task", { taskKey: key(3) });
  expect((second.parsed.blockedBy as { key: string }[]).map((b) => b.key)).toEqual([key(2)]);
  expect(second.parsed.parent.key).toBe(key(1));
  const first = await session.callTool("get_task", { taskKey: key(2) });
  expect(first.parsed.checklist.map((c: { text: string }) => c.text)).toEqual(["done well"]);
  const blocked = await session.callTool("get_task", { taskKey: key(6) });
  expect((blocked.parsed.blockedBy as { key: string }[]).map((b) => b.key)).toEqual([SIBLING_TASK_KEY]);

  // The tasks that failed were not made, and did not spend a number: the next one follows the last that was
  const all = await session.callTool("list_tasks", { project: PROJECT_KEY, search: "Wrong category" });
  expect(all.parsed.total).toBe(0);
  const lastMade = Math.max(...rows.filter((r) => r.key).map((r) => Number(r.key!.split("-").at(-1))));
  const next = await session.callTool("create_task", { project: PROJECT_KEY, title: "Right after the batch" });
  expect(next.parsed.taskNumber).toBe(lastMade + 1);
});

test("create_tasks takes a whole batch at its limit, and refuses one past it", async ({ request }) => {
  const session = await connected(request);
  const before = (await session.callTool("list_tasks", { project: PROJECT_KEY, limit: 1 })).parsed.total as number;

  const tasks = Array.from({ length: 30 }, (_, i) => ({ title: `Seeded ${i + 1}`, priority: i % 2 ? "low" : "medium" }));
  const started = Date.now();
  const answer = await session.callTool("create_tasks", { project: PROJECT_KEY, tasks });
  accepted(answer);
  expect(answer.parsed).toMatchObject({ requested: 30, created: 30, failed: 0 });
  expect(Date.now() - started).toBeLessThan(60_000);
  expect((await session.callTool("list_tasks", { project: PROJECT_KEY, limit: 1 })).parsed.total).toBe(before + 30);

  const tooMany = await session.callTool("create_tasks", { project: PROJECT_KEY, tasks: [...tasks, { title: "one more" }] });
  expect(tooMany.raw.error?.message ?? tooMany.text).toContain("30");
  expect((await session.callTool("list_tasks", { project: PROJECT_KEY, limit: 1 })).parsed.total).toBe(before + 30);
});

test("update_tasks and link_task_pairs act on many tasks and report each item", async ({ request }) => {
  const session = await connected(request);
  const made = await session.callTool("create_tasks", { project: PROJECT_KEY, tasks: [{ title: "A" }, { title: "B" }, { title: "C" }] });
  accepted(made);
  const [a, b, c] = (made.parsed.results as { key: string }[]).map((r) => r.key);

  const updated = await session.callTool("update_tasks", {
    updates: [
      { taskKey: a, title: "A renamed", priority: "urgent" },
      { taskKey: `${PROJECT_KEY}-9999`, title: "Nobody home" },
      { taskKey: b, assignee: MEMBER_USERNAME, dueDate: "2026-10-10" },
      { taskKey: c },
    ],
  });
  accepted(updated);
  expect(updated.parsed).toMatchObject({ requested: 4, updated: 2, failed: 2 });
  expect(updated.parsed.results[0]).toMatchObject({ n: 1, key: a, title: "A renamed", priority: "urgent" });
  expect(updated.parsed.results[1].error).toContain("not found");
  expect(updated.parsed.results[3].error).toContain("nothing to change");
  expect((await session.callTool("get_task", { taskKey: a })).parsed).toMatchObject({ title: "A renamed", priority: "urgent" });
  expect((await session.callTool("get_task", { taskKey: b })).parsed).toMatchObject({
    dueDate: expect.stringMatching(/^2026-10-10/),
    assignee: expect.objectContaining({ username: MEMBER_USERNAME }),
  });

  await seedSecondProject();
  await seedDemotableAdmin();
  const linked = await session.callTool("link_task_pairs", {
    links: [
      { taskKey: a, targetTaskKey: b, type: "parent_of" },
      { taskKey: c, targetTaskKey: a, type: "blocked_by" },
      { taskKey: a, targetTaskKey: KEPT_TASK_KEY, type: "relates" },
    ],
  });
  accepted(linked);
  expect(linked.parsed).toMatchObject({ requested: 3, linked: 2, failed: 1 });
  expect(linked.parsed.results[0].message).toBe(`Linked: ${a} is the parent of ${b}`);
  expect(linked.parsed.results[2].error).toContain("different boards");

  const parent = await session.callTool("get_task", { taskKey: a });
  expect((parent.parsed.children as { key: string }[]).map((x) => x.key)).toEqual([b]);
  expect((parent.parsed.blocking as { key: string }[]).map((x) => x.key)).toEqual([c]);
});
