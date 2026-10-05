import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { MEMBER_AUTH, SAME_ORIGIN } from "./api";
import { McpSession, type ToolCall } from "./mcp";
import {
  API_TOKEN,
  E2E_MONGODB_URI,
  HELD_TASK_KEY,
  HELD_TASK_NUMBER,
  MEMBER_API_TOKEN,
  MEMBER_ID,
  PROJECT_ID,
  PROJECT_KEY,
  SIBLING_TASK_NUMBER,
  WORKER_NAME,
  seed,
  storedTask,
  taskFactory,
} from "./seed";
import { signIn } from "./session";
import { expectToast, recordToasts } from "./toasts";

/**
 * BP-915. A member can archive a task and bring it back; only the board's owner can delete one.
 *
 * Driven through the screen a person uses, with the REST and MCP refusals beside it. Every refusal
 * has its control next to it — the same act by the person who may — because a refusal produced by a
 * mis-wired fixture reads exactly like one produced by the gate.
 */

const ALPHA = { number: 101, title: "Archive target alpha" };
const BETA = { number: 102, title: "Kept on the board beta" };
const GAMMA = { number: 103, title: "Owner deletes gamma" };

const board = `/projects/${PROJECT_KEY}`;
const taskPage = (number: number) => `${board}/tasks/${number}`;
const cardFor = (page: Page, number: number) => page.locator(`a[href="${taskPage(number)}"]`);

const ids = new Map<number, string>();

test.beforeEach(async () => {
  await seed();
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    const make = taskFactory(new Date());
    const db = mongoose.connection.db!;
    const inserted = await db.collection("tasks").insertMany([
      make({ taskNumber: ALPHA.number, title: ALPHA.title, status: "todo", assignee: MEMBER_ID, assignedBy: MEMBER_ID }),
      make({ taskNumber: BETA.number, title: BETA.title, status: "todo", assignee: MEMBER_ID, assignedBy: MEMBER_ID }),
      make({ taskNumber: GAMMA.number, title: GAMMA.title, status: "todo" }),
    ]);
    [ALPHA, BETA, GAMMA].forEach((task, index) => ids.set(task.number, String(inserted.insertedIds[index])));
    await db.collection("projects").updateOne({ _id: PROJECT_ID }, { $max: { taskCounter: GAMMA.number } });
  } finally {
    await mongoose.disconnect();
  }
});

async function openTask(page: Page, number: number) {
  await page.goto(taskPage(number));
  await expect(page.getByTestId("task-top-bar")).toBeVisible();
}

const archiveRequest = (page: Page, method: "POST" | "DELETE") =>
  page.waitForResponse((r) => /\/tasks\/[^/]+\/archive$/.test(r.url()) && r.request().method() === method);

async function archiveFromThePage(page: Page, number: number) {
  await openTask(page, number);
  const answered = archiveRequest(page, "POST");
  await page.getByRole("button", { name: "Archive task" }).first().click();
  expect((await answered).status()).toBe(200);
  await expect(page.getByTestId("archived-banner")).toBeVisible();
}

async function search(page: Page, text: string) {
  await page.goto(board);
  await expect(cardFor(page, BETA.number)).toBeVisible();
  await page.mouse.move(0, 0);
  await page.keyboard.press("ControlOrMeta+k");
  const layer = page.getByRole("dialog", { name: "Search" });
  await expect(layer).toBeVisible();
  const answered = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/search" && new URL(r.url()).searchParams.get("q") === text && r.status() === 200
  );
  await layer.getByLabel("Search tasks and projects").fill(text);
  await answered;
  return layer;
}

test.describe("a member archives a task", () => {
  test("it leaves the board, the list, search and my tasks, still opens by its link, and comes back from Show archived", async ({ page }) => {
    await signIn(page, "member");

    await archiveFromThePage(page, ALPHA.number);
    await page.getByRole("tab", { name: /History/ }).click();
    await expect(page.getByText(/archived this task/)).toBeVisible();

    await page.goto(board);
    await expect(cardFor(page, BETA.number)).toBeVisible();
    await expect(cardFor(page, ALPHA.number)).toHaveCount(0, { timeout: 1_000 });

    await page.evaluate(() => localStorage.setItem("view-mode:TP", "list"));
    await page.reload();
    await expect(page.getByRole("row", { name: new RegExp(BETA.title) })).toBeVisible();
    await expect(page.getByRole("row", { name: new RegExp(ALPHA.title) })).toHaveCount(0, { timeout: 1_000 });
    await page.evaluate(() => localStorage.setItem("view-mode:TP", "board"));

    const gone = await search(page, "Archive target");
    await expect(gone.getByRole("option")).toHaveCount(0, { timeout: 1_000 });
    await page.keyboard.press("Escape");
    const found = await search(page, "Kept on the board");
    await expect(found.getByRole("option", { name: new RegExp(BETA.title) })).toBeVisible();

    await page.goto("/my-tasks");
    await expect(page.getByText(BETA.title)).toBeVisible();
    await expect(page.getByText(ALPHA.title)).toHaveCount(0, { timeout: 1_000 });

    await page.goto(taskPage(ALPHA.number));
    await expect(page.getByTestId("archived-banner")).toBeVisible();
    await expect(page.getByLabel("Task title")).toHaveValue(ALPHA.title);

    await page.goto(board);
    await expect(cardFor(page, BETA.number)).toBeVisible();
    await page.getByText("Filters").click();
    await page.getByRole("checkbox", { name: "Show archived" }).check();
    const archivedCard = cardFor(page, ALPHA.number);
    await expect(archivedCard).toBeVisible();
    await expect(archivedCard.getByTestId("card-archived")).toBeVisible();
    await expect(cardFor(page, BETA.number).getByTestId("card-archived")).toHaveCount(0);

    await page.mouse.move(0, 0);
    await archivedCard.click({ button: "right" });
    const restored = archiveRequest(page, "DELETE");
    await page.getByRole("button", { name: "Restore" }).click();
    expect((await restored).status()).toBe(200);
    await expect(archivedCard.getByTestId("card-archived")).toHaveCount(0);

    await page.goto(board);
    await expect(cardFor(page, ALPHA.number)).toBeVisible();
    const activity = await page.request.get(`/api/projects/${PROJECT_KEY}/tasks/${ALPHA.number}/activity`);
    const actions = ((await activity.json()) as { action: string }[]).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["archived", "unarchived"]));
  });

  test("the banner restores it from its own page", async ({ page }) => {
    await signIn(page, "member");
    await archiveFromThePage(page, ALPHA.number);

    const restored = archiveRequest(page, "DELETE");
    await page.getByTestId("archived-banner").getByRole("button", { name: "Restore" }).click();
    expect((await restored).status()).toBe(200);
    await expect(page.getByTestId("archived-banner")).toHaveCount(0);

    await page.goto(board);
    await expect(cardFor(page, ALPHA.number)).toBeVisible();
  });

  test("counts, the dashboard's source and the sidebar's, leave it out", async ({ page }) => {
    await signIn(page, "member");
    const taskCount = async () =>
      ((await (await page.request.get("/api/projects")).json()) as { key: string; taskCount: number }[]).find(
        (p) => p.key === PROJECT_KEY
      )!.taskCount;
    const statsTotal = async () =>
      ((await (await page.request.get(`/api/projects/${PROJECT_KEY}/stats`)).json()) as { total: number }).total;
    const before = { count: await taskCount(), total: await statsTotal() };
    expect(before.count).toBeGreaterThan(0);

    await archiveFromThePage(page, ALPHA.number);

    expect(await taskCount()).toBe(before.count - 1);
    expect(await statsTotal()).toBe(before.total - 1);
  });
});

test.describe("deleting is the board owner's", () => {
  test("a member is not offered Delete anywhere, and the server refuses it and points at Archive", async ({ page }) => {
    await signIn(page, "member");
    await openTask(page, BETA.number);
    await expect(page.getByRole("button", { name: "Archive task" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete task" })).toHaveCount(0);

    await page.goto(board);
    await expect(cardFor(page, BETA.number)).toBeVisible();
    await cardFor(page, BETA.number).click({ button: "right" });
    await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);

    const refused = await page.request.delete(`/api/projects/${PROJECT_KEY}/tasks/${BETA.number}`, { headers: SAME_ORIGIN });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).error).toMatch(/Archive it instead/);
    const kept = await page.request.get(`/api/projects/${PROJECT_KEY}/tasks/${BETA.number}`);
    expect(kept.status()).toBe(200);
  });

  test("the owner deletes after confirming, and the task is gone", async ({ page }) => {
    await signIn(page, "owner");
    await openTask(page, GAMMA.number);
    await recordToasts(page);

    await page.getByRole("button", { name: "Delete task" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Delete Task" });
    await expect(dialog).toBeVisible();
    const answered = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().endsWith(`/tasks/${ids.get(GAMMA.number)}`));
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    expect((await answered).status()).toBe(200);
    await expectToast(page, "Task deleted");

    const gone = await page.request.get(`/api/projects/${PROJECT_KEY}/tasks/${GAMMA.number}`);
    expect(gone.status()).toBe(404);
  });
});

test.describe("a task a worker is running", () => {
  test("is archived only after the person confirms taking it from the worker", async ({ page }) => {
    await signIn(page, "member");
    await openTask(page, HELD_TASK_NUMBER);

    await page.getByRole("button", { name: "Archive task" }).first().click();
    const dialog = page.getByRole("dialog", { name: "This task is being executed" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(WORKER_NAME);
    await expect(page.getByTestId("archived-banner")).toHaveCount(0);

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect((await storedTask(HELD_TASK_NUMBER)).archivedAt ?? null).toBeNull();

    await page.getByRole("button", { name: "Archive task" }).first().click();
    await expect(dialog).toBeVisible();
    const forced = archiveRequest(page, "POST");
    await dialog.getByRole("button", { name: "Archive anyway" }).click();
    expect((await forced).status()).toBe(200);
    await expect(page.getByTestId("archived-banner")).toBeVisible();
    expect((await storedTask(HELD_TASK_NUMBER)).archivedAt).toBeTruthy();
  });

  test("answers a machine credential 409 naming the worker, and refuses it force", async ({ request }) => {
    const path = (number: number) => `/api/projects/${PROJECT_KEY}/tasks/${number}/archive`;

    const held = await request.post(path(HELD_TASK_NUMBER), { headers: MEMBER_AUTH, data: {} });
    expect(held.status()).toBe(409);
    expect((await held.json()).runConflict.workerName).toBe(WORKER_NAME);

    const forced = await request.post(path(HELD_TASK_NUMBER), { headers: MEMBER_AUTH, data: { force: true } });
    expect(forced.status()).toBe(403);
    expect((await storedTask(HELD_TASK_NUMBER)).archivedAt ?? null).toBeNull();

    const free = await request.post(path(SIBLING_TASK_NUMBER), { headers: MEMBER_AUTH, data: {} });
    expect(free.status()).toBe(200);
    expect((await free.json()).archivedAt).toBeTruthy();
  });
});

async function connected(request: APIRequestContext, token: string) {
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

const keys = (call: ToolCall) => (call.parsed.tasks as { key: string }[]).map((t) => t.key);

test.describe("over MCP", () => {
  test("a member archives and restores a task by key, and list_tasks finds it only when asked", async ({ request }) => {
    const mcp = await connected(request, MEMBER_API_TOKEN);
    const key = `${PROJECT_KEY}-${BETA.number}`;

    accepted(await mcp.callTool("archive_task", { taskKey: key }));

    const hidden = await mcp.callTool("list_tasks", { project: PROJECT_KEY });
    accepted(hidden);
    expect(keys(hidden)).not.toContain(key);
    expect(keys(hidden)).toContain(`${PROJECT_KEY}-${ALPHA.number}`);

    const only = await mcp.callTool("list_tasks", { project: PROJECT_KEY, archived: "only" });
    accepted(only);
    expect(keys(only)).toEqual([key]);
    expect(only.parsed.tasks[0].archived).toBe(true);

    const read = await mcp.callTool("get_task", { taskKey: key });
    accepted(read);
    expect(read.parsed.archivedAt).toBeTruthy();

    accepted(await mcp.callTool("unarchive_task", { taskKey: key }));
    expect(keys(await mcp.callTool("list_tasks", { project: PROJECT_KEY }))).toContain(key);
  });

  test("a member's delete_task is refused with a pointer to archive_task, and nothing is deleted", async ({ request }) => {
    const member = await connected(request, MEMBER_API_TOKEN);
    const key = `${PROJECT_KEY}-${GAMMA.number}`;

    const asked = await member.callTool("delete_task", { taskKey: key, confirmKey: key });
    refused(asked);
    expect(asked.text).toMatch(/archive_task/);
    accepted(await member.callTool("get_task", { taskKey: key }));

    const owner = await connected(request, API_TOKEN);
    accepted(await owner.callTool("get_task", { taskKey: key }));
  });

  test("the owner's delete_task needs the key repeated, and then deletes", async ({ request }) => {
    const mcp = await connected(request, API_TOKEN);
    const key = `${PROJECT_KEY}-${GAMMA.number}`;

    const wrong = await mcp.callTool("delete_task", { taskKey: key, confirmKey: `${PROJECT_KEY}-${BETA.number}` });
    refused(wrong);
    expect(wrong.text).toMatch(/Nothing was written/);
    accepted(await mcp.callTool("get_task", { taskKey: key }));

    accepted(await mcp.callTool("delete_task", { taskKey: key, confirmKey: key.toLowerCase() }));
    refused(await mcp.callTool("get_task", { taskKey: key }));
  });

  test("delete_task and archive_task never take a task from a running worker", async ({ request }) => {
    const owner = await connected(request, API_TOKEN);
    const member = await connected(request, MEMBER_API_TOKEN);

    const deleted = await owner.callTool("delete_task", { taskKey: HELD_TASK_KEY, confirmKey: HELD_TASK_KEY });
    refused(deleted);
    expect(deleted.text).toContain(WORKER_NAME);

    const archived = await member.callTool("archive_task", { taskKey: HELD_TASK_KEY });
    refused(archived);
    expect(archived.text).toContain(WORKER_NAME);

    accepted(await owner.callTool("get_task", { taskKey: HELD_TASK_KEY }));
    expect((await storedTask(HELD_TASK_NUMBER)).archivedAt ?? null).toBeNull();
  });
});
