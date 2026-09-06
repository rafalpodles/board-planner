import { test, expect, type APIRequestContext } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH } from "./api";
import {
  E2E_MONGODB_URI,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  SIBLING_TASK_ID,
  seed,
} from "./seed";
import { signIn } from "./session";

const SEEDED_TASKS = 4;

const CARDS = "[data-column-body] a[href*='/tasks/']";

test.beforeEach(seed);

async function refusedCreate(
  request: APIRequestContext,
  over: Record<string, unknown>
): Promise<string> {
  const response = await request.post(`/api/projects/${PROJECT_KEY}/tasks`, {
    headers: ADMIN_AUTH,
    data: { title: "Never created", ...over },
  });
  const body = await response.text();
  expect(response.status(), `${JSON.stringify(over)} — ${body}`).toBe(400);
  return body;
}

test("a refused create leaves the next task number unspent", async ({ page, request }) => {
  await test.step("every arm is refused, and refused with a 400", async () => {
    expect(await refusedCreate(request, { priority: "critical" })).toContain("priority");
    expect(await refusedCreate(request, { status: "nowhere" })).toContain("status");
    expect(await refusedCreate(request, { category: "chore" })).toContain("category");
    expect(await refusedCreate(request, { dueDate: "next thursday" })).toContain("due date");
    expect(await refusedCreate(request, { recurrence: { interval: 0 } })).toContain("recurrence");
    expect(await refusedCreate(request, { assignee: "nobody-here" })).toContain("nobody-here");

    const tasks = await request.get(`/api/projects/${PROJECT_KEY}/tasks`, { headers: ADMIN_AUTH });
    expect(await tasks.json()).toHaveLength(SEEDED_TASKS);
  });

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
  await expect(page.locator(CARDS)).toHaveCount(SEEDED_TASKS);

  const modal = page.getByRole("dialog", { name: "New Task" });
  await page.getByRole("button", { name: "New task" }).click();
  await expect(modal).toBeVisible();
  await expect(modal.getByPlaceholder("Describe what you need")).toBeVisible();
  await modal.getByLabel("Title").fill("The number nothing burnt");

  const posted = page.waitForResponse(
    (res) => res.request().method() === "POST" && res.url().endsWith("/tasks")
  );
  await modal.getByRole("button", { name: "Create Task" }).click();
  const created = await (await posted).json();

  expect(created.taskNumber).toBe(SEEDED_TASKS + 1);
  await expect(modal).toHaveCount(0);

  const card = page.locator(`a[href="/projects/${PROJECT_KEY}/tasks/${SEEDED_TASKS + 1}"]`);
  await expect(card).toContainText("The number nothing burnt");
  await expect(card).toContainText(`${PROJECT_KEY}-${SEEDED_TASKS + 1}`);
});

async function taskCounter(): Promise<number> {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  const project = await handle.collection("projects").findOne({ _id: PROJECT_ID });
  return project?.taskCounter as number;
}

async function storedTask() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  const task = await handle.collection("tasks").findOne({ _id: SIBLING_TASK_ID });
  if (!task) throw new Error("the sibling task is not seeded");
  return task;
}

const UNCASTABLE: { body: Record<string, unknown>; says: RegExp }[] = [
  { body: { order: "abc" }, says: /order/i },
  { body: { order: {} }, says: /order/i },
  { body: { order: [] }, says: /order/i },
  { body: { order: [5] }, says: /order/i },
  { body: { description: {} }, says: /description/i },
  { body: { description: ["a"] }, says: /description/i },
  { body: { checklist: [{ text: "a", done: {} }] }, says: /done/i },
  { body: { checklist: [{ text: "a", _id: "nope" }] }, says: /criterion.*id/i },
];

test("order and description cannot burn a number either", async ({ request }) => {
  const before = await taskCounter();

  for (const { body, says } of UNCASTABLE) {
    const said = JSON.stringify(body);
    expect(await refusedCreate(request, body), said).toMatch(says);
    expect(await taskCounter(), said).toBe(before);
  }

  const created = await request.post(`/api/projects/${PROJECT_KEY}/tasks`, {
    headers: ADMIN_AUTH,
    data: {
      title: "Ordered by a string",
      order: "2",
      description: "plain text",
      checklist: [{ text: "Ships with a test", done: "yes", mischief: "dropped" }],
    },
  });
  expect(created.status(), await created.text()).toBe(201);

  const task = await created.json();
  expect(task.order).toBe(2);
  expect(task.description).toBe("plain text");
  expect(task.checklist[0]).toMatchObject({ text: "Ships with a test", done: true });
  expect(task.checklist[0].mischief).toBeUndefined();
  expect(String(task.checklist[0]._id)).toMatch(/^[0-9a-f]{24}$/);
  expect(task.taskNumber).toBe(before + 1);
  expect(await taskCounter()).toBe(before + 1);
});

test("the same two shapes are refused on update, and nothing is written", async ({ request }) => {
  const before = await storedTask();

  for (const { body, says } of UNCASTABLE) {
    const said = JSON.stringify(body);
    const response = await request.put(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}`, {
      headers: ADMIN_AUTH,
      data: body,
    });
    expect(response.status(), `${said} — ${await response.text()}`).toBe(400);
    expect(await response.text(), said).toMatch(says);

    const after = await storedTask();
    expect(after.order, said).toBe(before.order);
    expect(after.description, said).toBe(before.description);
    expect(after.checklist, said).toEqual(before.checklist);
  }

  const accepted = await request.put(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}`, {
    headers: ADMIN_AUTH,
    data: { order: "7", description: "written by the update path" },
  });
  expect(accepted.status(), await accepted.text()).toBe(200);

  const after = await storedTask();
  expect(after.order).toBe(7);
  expect(after.description).toBe("written by the update path");
});
