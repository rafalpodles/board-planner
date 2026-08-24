import { test, expect, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import {
  HELD_TASK_KEY,
  PROJECT_ID,
  PROJECT_KEY,
  SIBLING_TASK_KEY,
  seed,
  seedSecondEscalationColumn,
  seedWebhookDeliveryOutcomes,
} from "./seed";
import { signIn } from "./session";

/**
 * The project's own settings: the board's columns, the categories tasks are described with, and
 * the save bar all three share.
 *
 * What every test here is really asking is whether the editor mirrors what the server will
 * accept. So the control is the state **after a reload** — a draft that looks right on screen and
 * never reached the server is the failure this spec exists to catch, and it is invisible to any
 * assertion made before the page is thrown away.
 *
 * Categories are here despite living on a different screen (`TaskFieldsSection`, beside custom
 * fields): to a person they are board structure, and they answer to the same save bar.
 *
 * The `done`-role boundary — what happens to unfinished work when a sprint closes on a board with
 * no done column — belongs to BP-389 and is deliberately not here.
 */

const SETTINGS = `/projects/${PROJECT_KEY}/settings`;

test.beforeEach(seed);

const saveButton = (page: Page) => page.getByRole("button", { name: "Save changes" });
const columnNames = (page: Page) => page.getByLabel("Column name");
const roleOf = (page: Page, label: string) =>
  page.getByLabel(`What ${label} means to automation`);

/**
 * The labels in the order the editor shows them.
 *
 * `evaluateAll` does not wait for anything, so after a reload it reads an empty list and the
 * assertion that follows compares nothing to something. The count is what the wait is for.
 */
async function labelsInOrder(page: Page, expected: number): Promise<string[]> {
  await expect(columnNames(page)).toHaveCount(expected);
  return columnNames(page).evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
}

async function openSection(page: Page, name: "Board" | "Task fields") {
  await page.goto(`${SETTINGS}?section=${name === "Board" ? "board" : "fields"}`);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

/** The columns as the server holds them, which is the only reader that settles a save. */
async function storedColumns(request: Parameters<typeof test>[0] extends never ? never : any) {
  const response = await request.get(`/api/projects/${PROJECT_ID}/columns`, {
    headers: ADMIN_AUTH,
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as { id: string; label: string; role: string }[];
}

/**
 * Saving, and waiting for the server rather than for the strip to slide away.
 *
 * The button's own label becomes "Saving..." while the request is in flight, so
 * `getByRole("button", { name: "Save changes" })` goes hidden the instant the click lands and
 * long before anything has been written. Four tests here read the stored board straight after
 * saving and got the board as it was — passing the click and failing the read.
 *
 * The success toast is emitted after the whole save chain has resolved, which for categories is
 * several requests, so it is the one signal that means "the server is done".
 */
async function save(page: Page, saved: "Columns saved" | "Categories saved") {
  await saveButton(page).click();
  await expect(page.getByText(saved)).toBeVisible();
  await expect(saveButton(page)).toBeHidden();
}

test.describe("Board · Columns", () => {
  test("a column added here is on the board the server serves, and survives a reload", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await openSection(page, "Board");

    await page.getByPlaceholder("New column name...").fill("Blocked");
    await page.getByRole("button", { name: "Add column" }).click();
    await roleOf(page, "Blocked").selectOption("blocked");
    await save(page, "Columns saved");

    const stored = await storedColumns(request);
    expect(stored.map((c) => c.label)).toContain("Blocked");
    expect(stored.find((c) => c.label === "Blocked")?.role).toBe("blocked");

    await page.reload();
    await expect(roleOf(page, "Blocked")).toHaveValue("blocked");
  });

  test("relabelling a column keeps its id, so the tasks standing in it stay put", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await openSection(page, "Board");

    // The empty column first, and deliberately: a column holding tasks cannot lose its id
    // quietly, because the server reads the old id as a removal and refuses. On an empty one
    // nothing refuses anything, so the id below is the only thing standing between a rename and
    // a new column.
    await test.step("a column nobody is standing in keeps its id", async () => {
      const planned = columnNames(page).nth(0);
      await expect(planned).toHaveValue("Planned");
      await planned.fill("Icebox");
      await save(page, "Columns saved");

      const stored = await storedColumns(request);
      expect(stored.find((c) => c.label === "Icebox")?.id).toBe("planned");
    });

    await test.step("and so does one holding two, which stay in it", async () => {
      const inProgress = columnNames(page).nth(2);
      await expect(inProgress).toHaveValue("In Progress");
      await inProgress.fill("Building");
      await save(page, "Columns saved");

      const stored = await storedColumns(request);
      expect(stored.find((c) => c.label === "Building")?.id).toBe("in_progress");

      await page.reload();
      await expect(columnNames(page).nth(2)).toHaveValue("Building");
      await expect(page.getByText("2 tasks")).toBeVisible();
    });
  });

  test("the arrows move a column, and the new order is the order after a reload", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await openSection(page, "Board");

    expect((await labelsInOrder(page, 7)).slice(0, 3)).toEqual([
      "Planned",
      "To Do",
      "In Progress",
    ]);

    // The second row's own up arrow: the label is shared by every row, so position is what names it
    await page.getByRole("button", { name: "Move column up" }).nth(1).click();
    await save(page, "Columns saved");

    const stored = await storedColumns(request);
    expect(stored.slice(0, 3).map((c) => c.label)).toEqual(["To Do", "Planned", "In Progress"]);

    await page.reload();
    expect((await labelsInOrder(page, 7)).slice(0, 3)).toEqual([
      "To Do",
      "Planned",
      "In Progress",
    ]);
  });

  test("an empty column can be removed; one holding tasks is refused, and the refusal names them", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await openSection(page, "Board");

    await test.step("Planned holds nothing, so it goes", async () => {
      await page.getByRole("button", { name: "Remove Planned" }).click();
      await save(page, "Columns saved");
      expect((await storedColumns(request)).map((c) => c.label)).not.toContain("Planned");
    });

    await test.step("In Progress holds two, so the server says no and says which", async () => {
      await page.getByRole("button", { name: "Remove In Progress" }).click();
      await saveButton(page).click();

      await expect(page.getByText(new RegExp(`still has tasks.*${HELD_TASK_KEY}`))).toBeVisible();
      await expect(page.getByText(new RegExp(SIBLING_TASK_KEY))).toBeVisible();
      // A refused save keeps the work on screen rather than pretending it landed
      await expect(saveButton(page)).toBeVisible();

      expect((await storedColumns(request)).map((c) => c.label)).toContain("In Progress");
      await page.reload();
      await expect(columnNames(page).filter({ has: page.locator("xpath=.") })).toHaveCount(6);
      await expect(roleOf(page, "In Progress")).toBeVisible();
    });
  });

  test("a draft nobody saved reaches the server not at all", async ({ page, request }) => {
    await signIn(page);
    await openSection(page, "Board");

    await columnNames(page).nth(2).fill("Never saved");
    await expect(saveButton(page)).toBeVisible();

    await page.reload();
    await expect(columnNames(page).nth(2)).toHaveValue("In Progress");
    expect((await storedColumns(request)).map((c) => c.label)).not.toContain("Never saved");
  });

  test("a board with nothing in the approved role says so, and an ordinary board does not", async ({
    page,
  }) => {
    const WARNING = /Workers and Claude Code have nowhere to take work from/;

    await signIn(page);
    await openSection(page, "Board");

    // The control: the seeded board has To Do in the approved role, so the warning is absent
    await expect(page.getByText(WARNING)).toBeHidden();

    await roleOf(page, "To Do").selectOption("backlog");
    await expect(page.getByText(WARNING)).toBeVisible();
  });
});

test.describe("Board · Hand-off to the PM agent", () => {
  test("the escalation column is the one chosen here, after a reload", async ({ page }) => {
    await signIn(page);
    await openSection(page, "Board");

    const escalation = page.getByLabel("Escalation column");
    await expect(escalation).toHaveValue("needs_human_review");

    await escalation.selectOption("ready_to_test");
    await save(page, "Columns saved");

    await page.reload();
    await expect(page.getByLabel("Escalation column")).toHaveValue("ready_to_test");
  });

  test("a board that hands off from two columns warns, and saving leaves one", async ({
    page,
  }) => {
    await seedSecondEscalationColumn();
    await signIn(page);
    await openSection(page, "Board");

    const warning = page.getByText(/hands off from more than one column/);
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("In Review");
    await expect(warning).toContainText("Needs Human Review");

    // Saving the section as it stands is what resolves it — the draft already carries one flag
    await page.getByLabel("Escalation column").selectOption("in_review");
    await save(page, "Columns saved");

    await page.reload();
    await expect(page.getByLabel("Escalation column")).toHaveValue("in_review");
    await expect(page.getByText(/hands off from more than one column/)).toBeHidden();
  });
});

test.describe("Task fields · Categories", () => {
  const categoryNames = (page: Page) => page.getByLabel("Category name");

  test("a category added here is one the server holds, after a reload", async ({ page }) => {
    await signIn(page);
    await openSection(page, "Task fields");

    await page.getByRole("button", { name: "+ Add category" }).click();
    await categoryNames(page).last().fill("spike");
    await save(page, "Categories saved");

    await page.reload();
    await expect(categoryNames(page).last()).toHaveValue("spike");
  });

  test("renaming a category carries the tasks that were using it", async ({ page, request }) => {
    await signIn(page);
    await openSection(page, "Task fields");

    const userStory = categoryNames(page).nth(2);
    await expect(userStory).toHaveValue("user-story");
    await userStory.fill("feature");
    await save(page, "Categories saved");

    // Tasks store the category by name and are validated against the project's list, so a rename
    // that did not carry them across would leave every card holding a name the project no longer
    // offers — and failing to save
    const task = await request.get(`/api/projects/${PROJECT_ID}/tasks/${HELD_TASK_KEY}`, {
      headers: ADMIN_AUTH,
    });
    expect(task.status(), await task.text()).toBe(200);
    expect((await task.json()).category).toBe("feature");

    // The rename adds the new name before dropping the old — deliberately, so no task is ever
    // holding a name the project does not offer — which moves the row to the end. What this test
    // is about is which names exist, not where they sit.
    await page.reload();
    await expect(categoryNames(page)).toHaveCount(4);
    const names = await categoryNames(page).evaluateAll((els) =>
      els.map((el) => (el as HTMLInputElement).value)
    );
    expect(names).toContain("feature");
    expect(names).not.toContain("user-story");
  });

  test("a category no task uses can go; one in use is refused, and the refusal names the tasks", async ({
    page,
  }) => {
    await signIn(page);
    await openSection(page, "Task fields");

    await test.step("nothing is filed under doc, so it goes", async () => {
      await page.getByRole("button", { name: "Remove doc" }).click();
      await save(page, "Categories saved");
      await page.reload();
      await expect(page.getByRole("button", { name: "Remove doc" })).toBeHidden();
    });

    await test.step("every seeded task is a user-story, so that one stays", async () => {
      await page.getByRole("button", { name: "Remove user-story" }).click();
      await saveButton(page).click();

      await expect(
        page.getByText(new RegExp(`user-story.*still used by.*${HELD_TASK_KEY}`))
      ).toBeVisible();
      await expect(saveButton(page)).toBeVisible();

      await page.reload();
      await expect(page.getByRole("button", { name: "Remove user-story" })).toBeVisible();
    });
  });
});

/**
 * BP-248, absorbed from settings-save.spec.ts. Saving an integration advanced the draft's baseline
 * only when the save **failed**, so a save that worked left the page believing it still had
 * unsaved work — and pressing Save again re-diffed against the stale baseline and re-sent work
 * already done. The audit log carries two removals of one webhook with no addition between them.
 *
 * These assert whether the save bar is **shown**, never what it says. SaveBar deliberately holds
 * its last summary in a ref so the strip does not flash "0 unsaved changes" while it slides away,
 * which means the text survives at `max-height: 0` long after the count reaches zero. A test
 * reading that text would pass before the fix and after it, and reading it is what cost an hour
 * of believing the fix had not worked.
 */
test.describe("Integrations · the save bar", () => {
  /** Webhooks are not on the page until added: the catalogue offers them behind the picker. */
  async function openWebhooks(page: Page) {
    await page.goto(SETTINGS);
    await page.getByRole("button", { name: "Integrations", exact: true }).first().click();
    // The picker only appears once something is already connected; on a board with no integrations
    // the tiles are on show already. Both states are normal, so neither is assumed.
    const picker = page.getByRole("button", { name: /Add integration/ });
    if (await picker.isVisible().catch(() => false)) await picker.click();

    // The row's accessible name has three forms — "Webhook Webhooks POST board events to any URL"
    // before anything is configured, "Webhooks 1 endpoint" after, and a separate "Configure
    // Webhooks" button beside it. Matching the first thing containing "Webhooks" survives all of
    // them; anchoring on any one description works exactly once and then rots.
    const input = page.getByPlaceholder("https://example.com/webhook");
    if (!(await input.isVisible().catch(() => false))) {
      await page.getByRole("button", { name: /Webhooks/ }).first().click();
    }
    return input;
  }

  async function addWebhook(page: Page, url: string) {
    const input = await openWebhooks(page);
    await input.fill(url);
    await page.getByRole("button", { name: "Add", exact: true }).click();
  }

  test("a webhook save that succeeds leaves no unsaved work behind", async ({ page }) => {
    await signIn(page);
    await addWebhook(page, "https://example.com/e2e-hook");

    await saveButton(page).click();

    // The whole defect in one assertion: the save worked and the page still asked to be saved
    await expect(saveButton(page)).toBeHidden();
    await expect(page.getByText("1 endpoint")).toBeVisible();
  });

  test("pressing Save again after a successful save sends nothing", async ({ page }) => {
    await signIn(page);
    await addWebhook(page, "https://example.com/e2e-hook");
    await saveButton(page).click();
    await expect(saveButton(page)).toBeHidden();

    const sent: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/webhooks") && r.method() !== "GET") sent.push(`${r.method()} ${r.url()}`);
    });

    // Add a second one and save again. If the baseline had not moved, this save would re-issue the
    // first webhook's POST alongside the second — two requests where one is correct.
    const input = await openWebhooks(page);
    await input.fill("https://example.com/second");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(saveButton(page)).toBeVisible();
    await saveButton(page).click();
    await expect(saveButton(page)).toBeHidden();

    expect(sent, "the first webhook was sent again alongside the second").toHaveLength(1);
  });

  test("a save that fails keeps the edit on screen to retry", async ({ page }) => {
    await signIn(page);
    await page.route("**/api/projects/*/webhooks", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 500, body: JSON.stringify({ error: "nope" }) })
        : route.continue()
    );

    await addWebhook(page, "https://example.com/e2e-hook");
    await saveButton(page).click();

    // The toast carries the server's own message, not the fallback — `fail` prefers err.message
    await expect(page.getByText("nope")).toBeVisible();
    await expect(saveButton(page), "a failed save must keep the work on screen").toBeVisible();
  });

  /**
   * BP-407. Delivery stays single-shot (rpo's call, see the ticket) — what changed is that the one
   * attempt's outcome is no longer silent. Not exercised through a real delivery (BP-408 blocks
   * that): the seed writes the outcome `dispatchWebhooks` itself would have written, and this only
   * asserts the settings page reads it back correctly.
   */
  test("the webhooks panel shows what the last delivery attempt did", async ({ page }) => {
    await seedWebhookDeliveryOutcomes();
    await signIn(page);
    await openWebhooks(page);

    await expect(page.getByText(/Last delivered/)).toBeVisible();
    await expect(page.getByText(/Last delivery failed/)).toBeVisible();
    await expect(page.getByText("connect ECONNREFUSED")).toBeVisible();
  });
});
