import { test, expect, type APIRequestContext } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { PROJECT_KEY, PROJECT_NAME, seed } from "./seed";
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
  expect(response.status(), body).toBe(400);
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
