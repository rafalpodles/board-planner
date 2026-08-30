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

/**
 * BP-438. `createTask` minted the task number with `$inc` and validated afterwards, so every
 * refusal past that line spent a number on a task that never existed — a permanent hole in the
 * board's numbering, and the next card a person creates carries the wrong key.
 *
 * The refusals are driven through the API deliberately: they are the requests the form cannot
 * make. Priority is a `<select>` on the screen, so "critical" only ever arrives from MCP — which
 * declares the field as a free-form string and forwards it unchecked — and that arm answered 500
 * as well as burning the number. What the test then checks is the UI, because that is where the
 * hole shows: the next task created from the board has to carry the number nothing spent.
 */

// seed() lays down four tasks and leaves taskCounter on the same number, so this is both the
// board's card count and the number the next created task has to mint.
const SEEDED_TASKS = 4;

const CARDS = "[data-column-body] a[href*='/tasks/']";

test.beforeEach(seed);

/** A create the server has to refuse, and the body it refused with. */
async function refusedCreate(
  request: APIRequestContext,
  over: Record<string, unknown>
): Promise<string> {
  const response = await request.post(`/api/projects/${PROJECT_KEY}/tasks`, {
    headers: ADMIN_AUTH,
    data: { title: "Never created", ...over },
  });
  const body = await response.text();
  // 400 rather than 500 is half the point: three of these used to escape as an uncaught
  // ValidationError, which says nothing a caller can act on
  // The request body, not just the answer: the arms differ only in the value they carry, so a
  // failure that names only the response cannot say which shape got through.
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

    const tasks = await request.get(`/api/projects/${PROJECT_KEY}/tasks`, { headers: ADMIN_AUTH });
    expect(await tasks.json()).toHaveLength(SEEDED_TASKS);
  });

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
  await expect(page.locator(CARDS)).toHaveCount(SEEDED_TASKS);

  // The control, and the assertion the whole spec exists for: five refusals ago this created
  // TP-10, and the board would never show a TP-5 to TP-9.
  const modal = page.getByRole("dialog", { name: "New Task" });
  await page.getByRole("button", { name: "New task" }).click();
  await expect(modal).toBeVisible();
  // AI Assist renders only once /ai/generate-task has answered, and it adds ~110px above these
  // fields. Awaited here so a late answer cannot shift the form under an action in flight.
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

/**
 * BP-445. `description` and `order` were never on BP-438's list and were handed straight to
 * `Task.create`, so a body the cast throws on answered 500 *and* spent a number — the failure
 * above, through two fields it did not name.
 *
 * The counter is read off the project document rather than inferred from the task list. The
 * numbers of tasks that already exist cannot move when nothing is created, which is how a first
 * pass of this measurement reported all six arms clean: an instrument that cannot register the
 * defect reads exactly like an absence of one.
 */

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

/**
 * `Number([])` is 0 and `Number([5])` is 5 — both finite, and both refused by Mongoose. They are
 * here because a guard written as "anything Number() makes finite" passes every other arm and
 * still lets these two through to the CastError it was added to prevent.
 */
const UNCASTABLE: { body: Record<string, unknown>; says: RegExp }[] = [
  { body: { order: "abc" }, says: /order/i },
  { body: { order: {} }, says: /order/i },
  { body: { order: [] }, says: /order/i },
  { body: { order: [5] }, says: /order/i },
  { body: { description: {} }, says: /description/i },
  { body: { description: ["a"] }, says: /description/i },
  // BP-499: the row's other keys rode uncast into the write, past the `$inc`
  { body: { checklist: [{ text: "a", done: {} }] }, says: /done/i },
  { body: { checklist: [{ text: "a", _id: "nope" }] }, says: /criterion.*id/i },
];

test("order and description cannot burn a number either", async ({ request }) => {
  const before = await taskCounter();

  for (const { body, says } of UNCASTABLE) {
    const said = JSON.stringify(body);
    // The field this arm actually carries, not `/order|description/`: a loose alternation cannot
    // tell an `order` arm answered by the description guard from one answered correctly
    expect(await refusedCreate(request, body), said).toMatch(says);
    expect(await taskCounter(), said).toBe(before);
  }

  // The control, and the half of the claim a refusal cannot make: the guard has to be exactly as
  // lenient as the cast it stands in for. Mongoose reads "2" as the number 2, so a body the schema
  // would have taken must still create — and must mint exactly one number doing it.
  const created = await request.post(`/api/projects/${PROJECT_KEY}/tasks`, {
    headers: ADMIN_AUTH,
    data: {
      title: "Ordered by a string",
      order: "2",
      description: "plain text",
      // "yes" is a boolean to Mongoose, and an unknown key must be dropped rather than forwarded
      checklist: [{ text: "Ships with a test", done: "yes", mischief: "dropped" }],
    },
  });
  expect(created.status(), await created.text()).toBe(201);

  const task = await created.json();
  expect(task.order).toBe(2);
  expect(task.description).toBe("plain text");
  expect(task.checklist[0]).toMatchObject({ text: "Ships with a test", done: true });
  expect(task.checklist[0].mischief).toBeUndefined();
  // Mongoose minted the row's id, because the body sent none
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

  // The control again: the update path has to keep taking what the cast takes, or a board reorder
  // — which is the only gesture that ever sends `order` — would refuse every drag.
  const accepted = await request.put(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}`, {
    headers: ADMIN_AUTH,
    data: { order: "7", description: "written by the update path" },
  });
  expect(accepted.status(), await accepted.text()).toBe(200);

  const after = await storedTask();
  expect(after.order).toBe(7);
  expect(after.description).toBe("written by the update path");
});
