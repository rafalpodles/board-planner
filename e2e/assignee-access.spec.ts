import { test, expect, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  OUTSIDER_FULL_NAME,
  OUTSIDER_TASK_NUMBER,
  OUTSIDER_USERNAME,
  PROJECT_KEY,
  PROJECT_NAME,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  seed,
  seedAssignmentOutsider,
} from "./seed";
import { signIn as arriveSignedIn, signInThroughForm } from "./session";

/**
 * BP-400. A task could be handed to somebody with no way to reach the board. Since BP-328 refuses
 * to deliver to them, they correctly hear nothing — which left the assignment itself silently
 * broken: a 200, an avatar on the card, and nobody working on it.
 *
 * Driven through the browser because the seam is the whole bug. Two halves fail differently and
 * neither implies the other: the picker is where a person makes the mistake, the API is where an
 * agent does. The API half has no UI path left by design — once the picker stops offering them
 * there is nothing to click — so that one arm is driven over HTTP and says so.
 *
 * Every test carries its control. A picker that offers nobody, or an API that refuses everybody,
 * would satisfy the negative assertions on its own; the positive case standing beside each one is
 * what tells the fix apart from a fixture that never worked.
 */

test.beforeEach(async () => {
  await seed();
  await seedAssignmentOutsider();
});

const taskUrl = (taskNumber: number) => `/projects/${PROJECT_KEY}/tasks/${taskNumber}`;

async function signIn(page: Page, username: string, password: string) {
  if (username === ADMIN_USERNAME) await arriveSignedIn(page);
  else if (username === MEMBER_USERNAME) await arriveSignedIn(page, "member");
  else return signInThroughForm(page, username, password);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
}

async function openTask(page: Page, username: string, password: string, taskNumber: number) {
  await signIn(page, username, password);
  await page.goto(taskUrl(taskNumber));
  await expect(page.getByText(`${PROJECT_KEY}-${taskNumber}`).first()).toBeVisible();
}

/**
 * Opens the rail's assignee picker and answers with the rows it is offering. Each row carries the
 * avatar's initials ahead of the name — "EME2E Member" — so the name is looked for INSIDE a row
 * rather than as the whole of one.
 */
async function assigneeOptions(page: Page): Promise<string[]> {
  await page.getByRole("combobox", { name: "Assignee" }).click();
  await expect(page.getByRole("option").first()).toBeVisible();
  return (await page.getByRole("option").allTextContents()).map((t) => t.trim());
}

const offers = (options: string[], name: string) => options.some((row) => row.includes(name));

test.describe("who the board offers", () => {
  test("offers the people who reach this board and not the ones who do not", async ({ page }) => {
    await openTask(page, ADMIN_USERNAME, ADMIN_PASSWORD, SIBLING_TASK_NUMBER);

    const options = await assigneeOptions(page);

    // The control: a picker that had failed to load at all would satisfy the line below it
    expect(offers(options, "E2E Member")).toBe(true);
    expect(offers(options, OUTSIDER_FULL_NAME)).toBe(false);
  });

  /**
   * The half of BP-400 the ticket did not know about. Both forms read the admin-only /api/users, so
   * a plain member got a 403, an empty roster, and — because the closed state resolves its label
   * out of the options — a task that IS assigned reading as "Unassigned".
   */
  test("lets a plain member assign somebody at all", async ({ page }) => {
    await openTask(page, MEMBER_USERNAME, MEMBER_PASSWORD, SIBLING_TASK_NUMBER);

    const options = await assigneeOptions(page);

    expect(offers(options, "E2E Member")).toBe(true);
    expect(offers(options, "E2E Admin")).toBe(true);
    expect(offers(options, OUTSIDER_FULL_NAME)).toBe(false);
  });

  test("offers only the same people to @mention", async ({ page }) => {
    await openTask(page, ADMIN_USERNAME, ADMIN_PASSWORD, SIBLING_TASK_NUMBER);

    await page.getByPlaceholder(/@mention someone/i).fill("thanks @");
    await expect(page.getByText("E2E Member").last()).toBeVisible();

    await expect(page.getByText(OUTSIDER_FULL_NAME)).toHaveCount(0);
  });
});

test.describe("what the server accepts", () => {
  /**
   * Over HTTP rather than through the browser, and deliberately: the picker no longer offers this
   * person, so no sequence of clicks reaches this case. What does reach it is MCP, the PM agent and
   * anything else holding a token — which is exactly who this refusal is for.
   */
  test("refuses an assignment to somebody who cannot reach the board", async ({ request }) => {
    const refused = await request.put(
      `/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}`,
      { headers: ADMIN_AUTH, data: { assignee: OUTSIDER_USERNAME } }
    );

    expect(refused.status()).toBe(400);
    expect(await refused.text()).toContain(OUTSIDER_USERNAME);
  });

  test("accepts one to somebody who can", async ({ request }) => {
    const accepted = await request.put(
      `/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}`,
      { headers: ADMIN_AUTH, data: { assignee: MEMBER_USERNAME } }
    );

    expect(accepted.status(), await accepted.text()).toBe(200);
    expect((await accepted.json()).assignee.username).toBe(MEMBER_USERNAME);
  });

  test("still lets the task be unassigned", async ({ request }) => {
    const cleared = await request.put(
      `/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}`,
      { headers: ADMIN_AUTH, data: { assignee: null } }
    );

    expect(cleared.status(), await cleared.text()).toBe(200);
  });
});

/**
 * The rows the fix must leave alone. Somebody assigned before they lost access is still the
 * assignee, and the board says so — the alternative is a card that quietly reads as unassigned
 * while the server has it assigned, which is the same silent lie BP-400 is about, told the other
 * way round.
 */
test.describe("an assignee who has since lost access", () => {
  test("is still named on the task", async ({ page }) => {
    await openTask(page, ADMIN_USERNAME, ADMIN_PASSWORD, OUTSIDER_TASK_NUMBER);

    const row = page.getByRole("combobox", { name: "Assignee" });
    await expect(row).toContainText(OUTSIDER_FULL_NAME);
    await expect(row).not.toContainText("Unassigned");
  });

  test("is left on the task by an edit to something else", async ({ page, request }) => {
    await openTask(page, ADMIN_USERNAME, ADMIN_PASSWORD, OUTSIDER_TASK_NUMBER);

    const saved = page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().includes("/tasks/")
    );
    await page.getByRole("textbox", { name: /title/i }).fill("Renamed, nothing else touched");
    await (await saved).finished();

    const task = await (
      await request.get(`/api/projects/${PROJECT_KEY}/tasks/${OUTSIDER_TASK_NUMBER}`, {
        headers: ADMIN_AUTH,
      })
    ).json();
    expect(task.assignee.username).toBe(OUTSIDER_USERNAME);
  });
});
