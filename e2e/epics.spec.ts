import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH } from "./api";
import { McpSession } from "./mcp";
import { E2E_MONGODB_URI, API_TOKEN, PROJECT_ID, PROJECT_KEY, SIBLING_TASK_NUMBER, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-916. An epic is a task with children, and until now the board could not say how far one was:
 * the card named a parent and nothing named a progress. What these drive is the number a person
 * reads — "1 of 4 done" on the card and on the page, the child rows under it, the filter that
 * narrows the board to one epic's children, and the same facts through MCP.
 *
 * Fixtures are written through the REST API, as a person's client would write them, so the links
 * are the stored `parent_of` ones and not a hand-built shape the server never produces.
 */

test.beforeEach(seed);

const BOARD = `/projects/${PROJECT_KEY}`;
const PHONE = { width: 390, height: 780 };
const taskUrl = (taskNumber: number) => `${BOARD}/tasks/${taskNumber}`;
const card = (page: Page, taskNumber: number): Locator =>
  page.locator(`[data-column-body] a[href="${taskUrl(taskNumber)}"]`);
const CARDS = "[data-column-body] a[href*='/tasks/']";

interface Made {
  _id: string;
  taskNumber: number;
}

async function create(request: APIRequestContext, title: string, status: string): Promise<Made> {
  const response = await request.post(`/api/projects/${PROJECT_ID}/tasks`, {
    headers: ADMIN_AUTH,
    data: { title, status },
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json();
}

async function adopt(request: APIRequestContext, epic: Made, child: Made) {
  const response = await request.post(`/api/projects/${PROJECT_ID}/tasks/${epic._id}/links`, {
    headers: ADMIN_AUTH,
    data: { taskId: child._id, type: "parent_of" },
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** Two epics: Alpha with four children in four columns (one done), Beta with two (none done). */
async function twoEpics(request: APIRequestContext, done = "done") {
  const alpha = await create(request, "Epic Alpha", "todo");
  const alphaKids = [
    await create(request, "Alpha todo child", "todo"),
    await create(request, "Alpha active child", "in_progress"),
    await create(request, "Alpha done child", done),
    await create(request, "Alpha review child", "in_review"),
  ];
  const beta = await create(request, "Epic Beta", "todo");
  const betaKids = [await create(request, "Beta first child", "todo"), await create(request, "Beta second child", "in_progress")];
  for (const kid of alphaKids) await adopt(request, alpha, kid);
  for (const kid of betaKids) await adopt(request, beta, kid);
  return { alpha, alphaKids, beta, betaKids };
}

async function openBoard(page: Page) {
  await signIn(page);
  await page.goto(BOARD);
  await expect(page.locator(CARDS).first()).toBeVisible();
}

test("an epic's card says how many of its children are done, and a task without children says nothing", async ({
  page,
  request,
}) => {
  const { alpha, beta } = await twoEpics(request);
  await openBoard(page);

  const alphaCard = card(page, alpha.taskNumber);
  await expect(alphaCard.getByText("1 of 4 done")).toBeVisible();
  const bar = alphaCard.getByRole("progressbar", { name: "Children done" });
  await expect(bar).toHaveAttribute("aria-valuenow", "1");
  await expect(bar).toHaveAttribute("aria-valuemax", "4");

  await expect(card(page, beta.taskNumber).getByText("0 of 2 done")).toBeVisible();

  await expect(card(page, SIBLING_TASK_NUMBER)).toBeVisible();
  await expect(card(page, SIBLING_TASK_NUMBER).getByRole("progressbar")).toHaveCount(0);
});

test("moving a child to the done column moves the epic's count with it", async ({ page, request }) => {
  const { alpha, alphaKids } = await twoEpics(request);
  await openBoard(page);
  const alphaCard = card(page, alpha.taskNumber);
  await expect(alphaCard.getByText("1 of 4 done")).toBeVisible();

  await card(page, alphaKids[0].taskNumber).click({ button: "right" });
  const moved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes("/status") && r.ok());
  await page.getByTestId("task-context-menu").getByRole("button", { name: "Done", exact: true }).click();
  await moved;

  // The board polls every ten seconds, so this has to be the read the move itself triggered
  await expect(alphaCard.getByText("2 of 4 done")).toBeVisible({ timeout: 1_000 });
  await expect(alphaCard.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");

  // And back out: a child leaving done takes the count with it
  await card(page, alphaKids[0].taskNumber).click({ button: "right" });
  const back = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes("/status") && r.ok());
  await page.getByTestId("task-context-menu").getByRole("button", { name: "To Do", exact: true }).click();
  await back;
  await expect(alphaCard.getByText("1 of 4 done")).toBeVisible({ timeout: 1_000 });
});

test("an epic's page shows the same count and lists its children, each opening its own page", async ({
  page,
  request,
}) => {
  const { alpha, alphaKids } = await twoEpics(request);
  await signIn(page);
  await page.goto(taskUrl(alpha.taskNumber));

  const children = page.locator("section", { has: page.getByText("Children", { exact: true }) });
  await expect(children.getByText("1 of 4 done")).toBeVisible();
  await expect(children.getByRole("progressbar", { name: "Children done" })).toHaveAttribute("aria-valuenow", "1");

  for (const [kid, title, status] of [
    [alphaKids[0], "Alpha todo child", "To Do"],
    [alphaKids[1], "Alpha active child", "In Progress"],
    [alphaKids[2], "Alpha done child", "Done"],
    [alphaKids[3], "Alpha review child", "In Review"],
  ] as const) {
    const row = children.locator("div.group", { hasText: title });
    await expect(row.getByRole("button", { name: `${PROJECT_KEY}-${kid.taskNumber}`, exact: true })).toBeVisible();
    await expect(row).toContainText(status);
  }

  await children.getByRole("button", { name: `${PROJECT_KEY}-${alphaKids[1].taskNumber}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${taskUrl(alphaKids[1].taskNumber)}$`));
  await expect(page.getByLabel("Task title")).toHaveValue("Alpha active child");
  // A child with no children of its own has no count
  await expect(page.getByRole("progressbar", { name: "Children done" })).toHaveCount(0);
});

test("done is the column's role, so a board whose done column is called shipped counts it", async ({
  page,
  request,
}) => {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    const columns = [
      { id: "icebox", label: "Icebox", color: "#6b7280", role: "backlog", order: 0 },
      { id: "todo", label: "To Do", color: "#3b82f6", role: "approved", order: 1 },
      { id: "in_progress", label: "In Progress", color: "#f59e0b", role: "active", order: 2 },
      { id: "in_review", label: "In Review", color: "#a855f7", role: "review", order: 3 },
      { id: "shipped", label: "Shipped", color: "#22c55e", role: "done", order: 4 },
      { id: "done", label: "Done (old)", color: "#9ca3af", role: "active", order: 5 },
    ];
    await mongoose.connection.db!.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { columns } });
  } finally {
    await mongoose.disconnect();
  }
  const { alpha, alphaKids } = await twoEpics(request, "shipped");
  const move = async (kid: { _id: string }, status: string) => {
    const response = await request.put(`/api/projects/${PROJECT_ID}/tasks/${kid._id}`, { headers: ADMIN_AUTH, data: { status } });
    expect(response.status(), await response.text()).toBe(200);
  };
  await move(alphaKids[0], "shipped");
  // In the column that is merely NAMED done, whose role is not: it does not count
  await move(alphaKids[1], "done");

  await signIn(page);
  await page.goto(taskUrl(alpha.taskNumber));
  await expect(page.getByText("2 of 4 done")).toBeVisible();
});

test.describe("the epic filter", () => {
  async function openFilters(page: Page) {
    const panel = page.getByRole("dialog", { name: "Filters" });
    if (!(await panel.isVisible())) await page.getByRole("button", { name: /^Filters/ }).click();
    await expect(panel).toBeVisible();
    return panel;
  }

  async function pickEpic(page: Page, label: string) {
    const panel = await openFilters(page);
    await panel.getByRole("combobox", { name: "Epic", exact: true }).selectOption({ label });
  }

  test("narrows the board to one epic's children, and another epic changes it", async ({ page, request }) => {
    const { alpha, alphaKids, beta, betaKids } = await twoEpics(request);
    await openBoard(page);
    const everything = await page.locator(CARDS).count();

    const panel = await openFilters(page);
    await expect(panel.getByRole("combobox", { name: "Epic", exact: true }).locator("option")).toHaveText([
      "All epics",
      `${PROJECT_KEY}-${alpha.taskNumber} Epic Alpha`,
      `${PROJECT_KEY}-${beta.taskNumber} Epic Beta`,
    ]);

    await pickEpic(page, `${PROJECT_KEY}-${alpha.taskNumber} Epic Alpha`);
    await expect(page.locator(CARDS)).toHaveCount(4);
    for (const kid of alphaKids) await expect(card(page, kid.taskNumber)).toBeVisible();
    for (const kid of betaKids) await expect(card(page, kid.taskNumber)).toHaveCount(0);
    await expect(card(page, alpha.taskNumber)).toHaveCount(0);

    await pickEpic(page, `${PROJECT_KEY}-${beta.taskNumber} Epic Beta`);
    await expect(page.locator(CARDS)).toHaveCount(2);
    for (const kid of betaKids) await expect(card(page, kid.taskNumber)).toBeVisible();
    for (const kid of alphaKids) await expect(card(page, kid.taskNumber)).toHaveCount(0);

    await pickEpic(page, "All epics");
    await expect(page.locator(CARDS)).toHaveCount(everything);
  });

  test("keeps the choice across a reload and into the list, and its chip clears it", async ({ page, request }) => {
    const { alpha } = await twoEpics(request);
    await openBoard(page);
    await pickEpic(page, `${PROJECT_KEY}-${alpha.taskNumber} Epic Alpha`);
    await expect(page.locator(CARDS)).toHaveCount(4);

    await page.reload();
    await expect(page.locator(CARDS)).toHaveCount(4);

    await page.getByRole("button", { name: "List", exact: true }).click();
    const rows = page.locator("table tbody tr");
    await expect(rows).toHaveCount(4);
    for (const title of ["Alpha todo child", "Alpha active child", "Alpha done child", "Alpha review child"]) {
      await expect(rows.filter({ hasText: title })).toBeVisible();
    }
    await expect(rows.filter({ hasText: "Beta first child" })).toHaveCount(0);

    const panel = await openFilters(page);
    await panel.getByRole("button", { name: `Remove Epic ${PROJECT_KEY}-${alpha.taskNumber} filter` }).click();
    await expect(rows.filter({ hasText: "Beta first child" })).toBeVisible();
  });

  test("is not offered on a board with no epics", async ({ page }) => {
    await openBoard(page);
    const panel = await openFilters(page);
    await expect(panel.getByLabel("Assignee")).toBeVisible();
    await expect(panel.getByRole("combobox", { name: "Epic", exact: true })).toHaveCount(0);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test("the card, the page and the filter all fit and say the same thing", async ({ page, request }) => {
    const { alpha, alphaKids } = await twoEpics(request);
    await openBoard(page);
    await expect(card(page, alpha.taskNumber).getByText("1 of 4 done")).toBeVisible();

    await page.getByRole("button", { name: /^Filters/ }).click();
    const panel = page.getByRole("dialog", { name: "Filters" });
    await panel.getByRole("combobox", { name: "Epic", exact: true }).selectOption({ label: `${PROJECT_KEY}-${alpha.taskNumber} Epic Alpha` });
    await expect(page.locator(CARDS)).toHaveCount(4);
    expect(await panel.boundingBox().then((b) => (b ? b.x >= 0 && b.x + b.width <= PHONE.width : false))).toBe(true);

    await page.goto(taskUrl(alpha.taskNumber));
    await expect(page.getByText("1 of 4 done")).toBeVisible();
    await expect(page.getByRole("button", { name: `${PROJECT_KEY}-${alphaKids[0].taskNumber}`, exact: true })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});

test.describe("over MCP", () => {
  async function session(request: APIRequestContext) {
    const mcp = new McpSession(request, API_TOKEN);
    await mcp.open();
    return mcp;
  }

  test("get_task answers an epic's children and progress, and a plain task neither", async ({ request }) => {
    const { alpha, alphaKids } = await twoEpics(request);
    const mcp = await session(request);

    const epic = await mcp.callTool("get_task", { taskKey: `${PROJECT_KEY}-${alpha.taskNumber}` });
    expect(epic.raw.result?.isError ?? false, epic.text).toBe(false);
    expect(epic.parsed.progress).toEqual({ total: 4, done: 1, byStatus: { todo: 1, in_progress: 1, done: 1, in_review: 1 } });
    expect(epic.parsed.children.map((c: { key: string }) => c.key).sort()).toEqual(
      alphaKids.map((k) => `${PROJECT_KEY}-${k.taskNumber}`).sort()
    );
    expect(epic.parsed.children[0]).toMatchObject({ title: expect.any(String), status: expect.any(String) });

    const child = await mcp.callTool("get_task", { taskKey: `${PROJECT_KEY}-${alphaKids[0].taskNumber}` });
    expect(child.parsed).not.toHaveProperty("progress");
    expect(child.parsed.parent).toMatchObject({ key: `${PROJECT_KEY}-${alpha.taskNumber}` });
  });

  test("list_tasks finds the epics with their progress, and the children of one", async ({ request }) => {
    const { alpha, alphaKids, beta } = await twoEpics(request);
    const mcp = await session(request);

    const epics = await mcp.callTool("list_tasks", { project: PROJECT_KEY, hasChildren: true });
    expect(epics.raw.result?.isError ?? false, epics.text).toBe(false);
    expect(epics.parsed.tasks.map((t: { key: string; progress: string }) => [t.key, t.progress]).sort()).toEqual(
      [
        [`${PROJECT_KEY}-${alpha.taskNumber}`, "1 of 4 done"],
        [`${PROJECT_KEY}-${beta.taskNumber}`, "0 of 2 done"],
      ].sort()
    );

    const leaves = await mcp.callTool("list_tasks", { project: PROJECT_KEY, hasChildren: false });
    const leafKeys = leaves.parsed.tasks.map((t: { key: string }) => t.key);
    expect(leafKeys).toContain(`${PROJECT_KEY}-${alphaKids[0].taskNumber}`);
    expect(leafKeys).not.toContain(`${PROJECT_KEY}-${alpha.taskNumber}`);

    const children = await mcp.callTool("list_tasks", { project: PROJECT_KEY, parent: `${PROJECT_KEY}-${alpha.taskNumber}` });
    expect(children.parsed.tasks.map((t: { key: string }) => t.key).sort()).toEqual(
      alphaKids.map((k) => `${PROJECT_KEY}-${k.taskNumber}`).sort()
    );
  });
});
