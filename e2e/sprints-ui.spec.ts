import { test, expect, type Locator, type Page, type Response } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  LIFECYCLE_CURRENT_GOAL,
  LIFECYCLE_CURRENT_ID,
  LIFECYCLE_CURRENT_NAME,
  LIFECYCLE_FINISHED_TASK_NUMBER,
  LIFECYCLE_PAST_ONE_DELIVERED,
  LIFECYCLE_PAST_ONE_ID,
  LIFECYCLE_PAST_ONE_NAME,
  LIFECYCLE_PAST_TWO_DELIVERED,
  LIFECYCLE_PAST_TWO_NAME,
  LIFECYCLE_PLANNED_ID,
  LIFECYCLE_PLANNED_NAME,
  LIFECYCLE_UNFINISHED_TASK_NUMBER,
  PROJECT_KEY,
  demoteDoneColumn,
  seed,
  seedSprintLifecycle,
  storedSprint,
  storedTaskSprint,
} from "./seed";

/**
 * BP-389. Sprints away from the planning drag, which is e2e/sprint-planning.spec.ts: creating,
 * editing, activating, closing and deleting one through the screens, the velocity chart on totals
 * a real aggregation produced, and the selected sprint surviving a reload.
 *
 * `column-roles.spec.ts` already closes a sprint **by API**, including on a board whose done-role
 * column is called something else. Nothing here repeats that. What does belong here is the case
 * the two tickets meet on: a board with no done-role column at all, closed from the screen — every
 * task counts as unfinished then, the one sitting in the column still labelled Done included.
 *
 * Give this run its own database and port block; the fixture empties whatever it is pointed at:
 *   E2E_PORT=4060 PM_STUB_PORT=4061 AI_STUB_PORT=4062 WEBHOOK_RECEIVER_PORT=4063 \
 *   E2E_MONGODB_URI=mongodb://localhost:27017/bp389_e2e npx playwright test e2e/sprints-ui.spec.ts
 *
 * Every assertion about a write is taken from the database rather than from the screen it was made
 * on: a name that only ever existed in React state would look identical to one that was saved.
 */

const sprintsUrl = `/projects/${PROJECT_KEY}/sprints`;
const tasksPath = `/api/projects/${PROJECT_KEY}/tasks`;
const boardApiPrefix = `/api/projects/${PROJECT_KEY}/`;

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN_USERNAME);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);
}

function sprintList(page: Page): Locator {
  return page.getByRole("navigation", { name: "Sprint list" });
}

/** A row in the sprint list; its accessible name carries the counts too ("Sprint 7 1/2"). */
function sprintRow(page: Page, name: string): Locator {
  return sprintList(page).getByRole("button", { name: new RegExp(`^${name}\\b`) });
}

function selectedSprintName(page: Page): Locator {
  return page.getByTestId("sprint-name");
}

function statusBadge(page: Page): Locator {
  return page.getByTestId("sprint-status");
}

function progress(page: Page): Locator {
  return page.getByTestId("sprint-progress");
}

/** The board's own GET /sprints poll is constant, so a write is matched by method. */
function sprintWrite(page: Page, method: "POST" | "PUT" | "DELETE"): Promise<Response> {
  return page.waitForResponse(
    (r) =>
      r.request().method() === method &&
      new URL(r.url()).pathname.startsWith(`/api/projects/${PROJECT_KEY}/sprints`)
  );
}

async function openSprints(page: Page, query = "") {
  await page.goto(`${sprintsUrl}${query}`);
  await expect(selectedSprintName(page)).toBeVisible();
}

test.beforeEach(async () => {
  await seed();
  await seedSprintLifecycle();
});

test.describe("creating and editing a sprint from the form", () => {
  test("creates the sprint that was typed, and the board it lands on is the server's", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await openSprints(page);

    await page.getByRole("button", { name: "New Sprint" }).click();
    const form = page.getByRole("dialog", { name: "New Sprint" });

    // Computed in the browser from the sprints it just fetched — "Sprint 8" is the latest-ending
    // sprint, so the suggestion is the next number. A fill() landing before hydration would be
    // dropped silently, and this value is what proves React is running before anything is typed.
    await expect(form.getByLabel("Name")).toHaveValue("Sprint 9");

    const startInput = form.locator('input[type="date"]').first();
    const endInput = form.locator('input[type="date"]').nth(1);
    const suggestedEnd = await endInput.inputValue();

    await test.step("choosing a duration moves the end date, without touching the start", async () => {
      const suggestedStart = await startInput.inputValue();
      await form.locator("select").selectOption("7");
      await expect(endInput).not.toHaveValue(suggestedEnd);
      expect(await startInput.inputValue()).toBe(suggestedStart);
      const span =
        (Date.parse(`${await endInput.inputValue()}T00:00:00Z`) -
          Date.parse(`${suggestedStart}T00:00:00Z`)) /
        86_400_000;
      expect(span).toBe(7);
      await expect(form.getByText("7 days")).toBeVisible();
    });

    const startDate = await startInput.inputValue();
    const endDate = await endInput.inputValue();
    await form.getByLabel("Name").fill("Sprint Zeppelin");
    await form.getByLabel("Goal (optional)").fill("Moor the airship");

    const created = sprintWrite(page, "POST");
    await form.getByRole("button", { name: "Create" }).click();
    expect((await created).status()).toBe(201);

    await test.step("it joins the planned sprints in the list", async () => {
      await expect(
        sprintList(page).getByRole("group", { name: "Planned" }).getByRole("button", {
          name: /^Sprint Zeppelin/,
        })
      ).toBeVisible();
    });

    await test.step("the server holds the name, goal and both dates", async () => {
      const response = await request.get(`/api/projects/${PROJECT_KEY}/sprints`, {
        headers: ADMIN_AUTH,
      });
      expect(response.status()).toBe(200);
      const stored = (await response.json()).find(
        (s: { name: string }) => s.name === "Sprint Zeppelin"
      );
      expect(stored, "the new sprint is missing from the server's own list").toBeTruthy();
      expect(stored.goal).toBe("Moor the airship");
      expect(stored.status).toBe("planned");
      expect(String(stored.startDate)).toContain(startDate);
      expect(String(stored.endDate)).toContain(endDate);
    });

    await test.step("and a reload finds it there, not only in this tab's state", async () => {
      await page.reload();
      await expect(sprintRow(page, "Sprint Zeppelin")).toBeVisible();
    });
  });

  test("editing renames the sprint on the server, goal included, and leaves its dates alone", async ({
    page,
  }) => {
    await signIn(page);
    await openSprints(page);
    await expect(selectedSprintName(page)).toHaveText(LIFECYCLE_CURRENT_NAME);
    const before = await storedSprint(LIFECYCLE_CURRENT_ID);

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const form = page.getByRole("dialog", { name: "Edit Sprint" });
    await expect(form.getByLabel("Name")).toHaveValue(LIFECYCLE_CURRENT_NAME);
    await expect(form.getByLabel("Goal (optional)")).toHaveValue(LIFECYCLE_CURRENT_GOAL);

    await form.getByLabel("Name").fill("Sprint 7 — mast week");
    await form.getByLabel("Goal (optional)").fill("Raise the mast");
    const saved = sprintWrite(page, "PUT");
    await form.getByRole("button", { name: "Update" }).click();
    expect((await saved).status()).toBe(200);

    await expect(selectedSprintName(page)).toHaveText("Sprint 7 — mast week");

    const after = await storedSprint(LIFECYCLE_CURRENT_ID);
    expect(after?.name).toBe("Sprint 7 — mast week");
    expect(after?.goal).toBe("Raise the mast");
    // The form re-submits both dates on every edit, through a round trip that drops the time of
    // day. The day itself must survive: a rename that walks a sprint's dates is a real bug.
    const day = (value: unknown) => new Date(String(value)).toISOString().substring(0, 10);
    expect(day(after?.startDate)).toBe(day(before?.startDate));
    expect(day(after?.endDate)).toBe(day(before?.endDate));

    await page.reload();
    await expect(selectedSprintName(page)).toHaveText("Sprint 7 — mast week");
  });

  test("activating a planned sprint closes the one that was running", async ({ page }) => {
    await signIn(page);
    await openSprints(page, `?sprint=${LIFECYCLE_PLANNED_ID}`);

    await expect(selectedSprintName(page)).toHaveText(LIFECYCLE_PLANNED_NAME);
    await expect(statusBadge(page)).toHaveText("Planned");

    const activated = sprintWrite(page, "PUT");
    await page.getByRole("button", { name: "Activate" }).click();
    expect((await activated).status()).toBe(200);

    await expect(statusBadge(page)).toHaveText("Active");
    // Only one sprint runs at a time, and the server says so by *completing* the other one — a
    // side effect nothing on this screen announces, so the list is where a person meets it
    await expect(
      sprintList(page)
        .getByRole("group", { name: "Completed" })
        .getByRole("button", { name: new RegExp(`^${LIFECYCLE_CURRENT_NAME}\\b`) })
    ).toBeVisible();

    expect((await storedSprint(LIFECYCLE_PLANNED_ID))?.status).toBe("active");
    expect((await storedSprint(LIFECYCLE_CURRENT_ID))?.status).toBe("completed");
  });

  test("deleting a sprint asks first, and returns its tasks to the backlog", async ({ page }) => {
    await signIn(page);
    await openSprints(page);

    await test.step("cancelling leaves the sprint and its tasks exactly where they were", async () => {
      await page.getByRole("button", { name: `Delete sprint ${LIFECYCLE_CURRENT_NAME}` }).click();
      const confirm = page.getByRole("dialog", { name: "Delete Sprint" });
      await expect(confirm).toContainText("Tasks in this sprint will be moved to backlog");
      await confirm.getByRole("button", { name: "Cancel" }).click();
      await expect(confirm).toHaveCount(0);
      expect((await storedSprint(LIFECYCLE_CURRENT_ID))?.name).toBe(LIFECYCLE_CURRENT_NAME);
      expect(await storedTaskSprint(LIFECYCLE_UNFINISHED_TASK_NUMBER)).toBe(
        String(LIFECYCLE_CURRENT_ID)
      );
    });

    await page.getByRole("button", { name: `Delete sprint ${LIFECYCLE_CURRENT_NAME}` }).click();
    const deleted = sprintWrite(page, "DELETE");
    await page
      .getByRole("dialog", { name: "Delete Sprint" })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    expect((await deleted).status()).toBe(200);

    expect(await storedSprint(LIFECYCLE_CURRENT_ID)).toBeNull();
    // Both of them, done and undone alike: a deleted sprint keeps nobody's work
    expect(await storedTaskSprint(LIFECYCLE_FINISHED_TASK_NUMBER)).toBeNull();
    expect(await storedTaskSprint(LIFECYCLE_UNFINISHED_TASK_NUMBER)).toBeNull();

    await page.reload();
    await expect(sprintRow(page, LIFECYCLE_CURRENT_NAME)).toHaveCount(0);
  });
});

test.describe("closing a sprint from the header", () => {
  test("the dialog counts what is unfinished, and Move to Backlog leaves the finished task behind", async ({
    page,
  }) => {
    await signIn(page);
    await openSprints(page);
    await expect(progress(page)).toHaveText("1/2");
    // The control for the two absences asserted after the close
    await expect(page.getByRole("button", { name: "Planning", exact: true })).toHaveCount(1);

    await page.getByRole("button", { name: "Complete", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Complete Sprint" });
    await expect(dialog).toContainText(`Completing ${LIFECYCLE_CURRENT_NAME}`);
    await expect(dialog).toContainText("There is 1 incomplete task");

    const closed = sprintWrite(page, "PUT");
    await dialog.getByRole("button", { name: "Move to Backlog" }).click();
    expect((await closed).status()).toBe(200);

    await test.step("the sprint reads as finished and offers nothing further to do to it", async () => {
      await expect(statusBadge(page)).toHaveText("Completed");
      await expect(page.getByRole("button", { name: "Complete", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Planning", exact: true })).toHaveCount(0);
    });

    await test.step("only the unfinished task went back to the backlog", async () => {
      expect(await storedTaskSprint(LIFECYCLE_UNFINISHED_TASK_NUMBER)).toBeNull();
      expect(await storedTaskSprint(LIFECYCLE_FINISHED_TASK_NUMBER)).toBe(
        String(LIFECYCLE_CURRENT_ID)
      );
      expect((await storedSprint(LIFECYCLE_CURRENT_ID))?.status).toBe("completed");
    });

    await page.reload();
    await expect(statusBadge(page)).toHaveText("Completed");
  });

  test("Keep in Sprint closes it without moving anything", async ({ page }) => {
    await signIn(page);
    await openSprints(page);

    const closed = sprintWrite(page, "PUT");
    await page.getByRole("button", { name: "Complete", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Complete Sprint" })
      .getByRole("button", { name: "Keep in Sprint" })
      .click();
    expect((await closed).status()).toBe(200);

    await expect(statusBadge(page)).toHaveText("Completed");
    // The control for the test above: the same close, the other button, and the unfinished task
    // that moved there stays where it was
    expect(await storedTaskSprint(LIFECYCLE_UNFINISHED_TASK_NUMBER)).toBe(
      String(LIFECYCLE_CURRENT_ID)
    );
    expect(await storedTaskSprint(LIFECYCLE_FINISHED_TASK_NUMBER)).toBe(
      String(LIFECYCLE_CURRENT_ID)
    );
    expect((await storedSprint(LIFECYCLE_CURRENT_ID))?.status).toBe("completed");
  });

  test("on a board with no done column, nothing counts as finished and everything is swept out", async ({
    page,
  }) => {
    await demoteDoneColumn();
    await signIn(page);
    await openSprints(page);

    // The task in the column still labelled Done is no longer in a done-*role* column, so the
    // board cannot say anything is finished
    await expect(progress(page)).toHaveText("0/2");

    await page.getByRole("button", { name: "Complete", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Complete Sprint" });
    await expect(dialog).toContainText("There are 2 incomplete tasks");

    const closed = sprintWrite(page, "PUT");
    await dialog.getByRole("button", { name: "Move to Backlog" }).click();
    expect((await closed).status()).toBe(200);

    expect(await storedTaskSprint(LIFECYCLE_UNFINISHED_TASK_NUMBER)).toBeNull();
    expect(await storedTaskSprint(LIFECYCLE_FINISHED_TASK_NUMBER)).toBeNull();
  });
});

test.describe("velocity", () => {
  test("plots what each completed sprint delivered, oldest first", async ({ page }) => {
    await signIn(page);
    await openSprints(page);

    await page.getByRole("button", { name: "Velocity" }).click();
    const chart = page.getByRole("img", { name: /^Velocity across completed sprints/ });
    // Sprint 5 also carries an unfinished task worth 4, so 8 here is *delivered* points rather
    // than committed ones — the aggregation's $cond, which no fixture of one task can tell apart
    await expect(chart).toHaveAttribute(
      "aria-label",
      `Velocity across completed sprints: ${LIFECYCLE_PAST_ONE_NAME} ${LIFECYCLE_PAST_ONE_DELIVERED}, ${LIFECYCLE_PAST_TWO_NAME} ${LIFECYCLE_PAST_TWO_DELIVERED}`
    );

    await test.step("and the bars are drawn to those numbers, not to equal heights", async () => {
      const bars = chart.locator("rect");
      await expect(bars).toHaveCount(2);
      const heights = await bars.evaluateAll((nodes) =>
        nodes.map((node) => Number(node.getAttribute("height")))
      );
      // Measured against each other rather than against BAR_TRACK_PX, which is a cosmetic choice
      expect(heights[0] / heights[1]).toBe(
        LIFECYCLE_PAST_ONE_DELIVERED / LIFECYCLE_PAST_TWO_DELIVERED
      );
    });
  });

  test("with a single completed sprint the button is still offered and says why there is no chart", async ({
    page,
    request,
  }) => {
    // Reopened through the API rather than reseeded: this is the same board, one sprint short
    const reopened = await request.put(
      `/api/projects/${PROJECT_KEY}/sprints/${LIFECYCLE_PAST_ONE_ID}`,
      { headers: ADMIN_AUTH, data: { status: "planned" } }
    );
    expect(reopened.status()).toBe(200);

    await signIn(page);
    await openSprints(page);

    // One completed sprint is enough for the page to offer the chart, and not enough to draw one
    await page.getByRole("button", { name: "Velocity" }).click();
    await expect(
      page.getByText("Velocity appears once there are two completed sprints.")
    ).toBeVisible();
    await expect(page.getByRole("img", { name: /^Velocity across/ })).toHaveCount(0);
  });
});

test.describe("which sprint the page opens on", () => {
  test("a picked sprint survives a reload; an unpicked page opens on the active one", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(sprintsUrl);

    await test.step("with nothing asked for, the running sprint is the one shown", async () => {
      await expect(selectedSprintName(page)).toHaveText(LIFECYCLE_CURRENT_NAME);
      await expect(page).toHaveURL(new RegExp(`sprint=${LIFECYCLE_CURRENT_ID}`));
    });

    await sprintRow(page, LIFECYCLE_PAST_ONE_NAME).click();
    await expect(selectedSprintName(page)).toHaveText(LIFECYCLE_PAST_ONE_NAME);
    await expect(page).toHaveURL(new RegExp(`sprint=${LIFECYCLE_PAST_ONE_ID}`));

    await page.reload();
    await expect(selectedSprintName(page)).toHaveText(LIFECYCLE_PAST_ONE_NAME);
    await expect(sprintRow(page, LIFECYCLE_PAST_ONE_NAME)).toHaveAttribute("aria-current", "true");
  });

  test("a malformed sprint id in the URL is never asked for, and falls back", async ({ page }) => {
    await signIn(page);

    // Two guards stand between a bad bookmark and the database: this page validates the id against
    // the sprints it fetched before it scopes anything to it, and the tasks endpoint refuses a
    // value that is not an ObjectId with a 400. The second is why nothing here watches for a 500 —
    // what is watched instead is the first: any refusal at all means the page asked anyway.
    const answered: string[] = [];
    const refused: string[] = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith(boardApiPrefix)) return;
      answered.push(`${response.status()} ${url.pathname}${url.search}`);
      if (response.status() >= 400) refused.push(`${response.status()} ${url.pathname}${url.search}`);
    });

    await openSprints(page, "?sprint=not-a-real-sprint");

    await expect(selectedSprintName(page)).toHaveText(LIFECYCLE_CURRENT_NAME);
    await expect(page).toHaveURL(new RegExp(`sprint=${LIFECYCLE_CURRENT_ID}`));

    // The positive control: the page did fetch this board's tasks, and it asked for the sprint it
    // fell back to. Without it an empty `refused` would also be what a listener watching the wrong
    // path, or a page that fetched nothing at all, looks like.
    const taskFetches = answered.filter((entry) => entry.includes(tasksPath));
    expect(taskFetches.length).toBeGreaterThan(0);
    for (const entry of taskFetches) {
      expect(entry).toContain(`sprint=${LIFECYCLE_CURRENT_ID}`);
    }
    expect(refused).toEqual([]);
  });

  test("a well-formed id for a sprint that is gone falls back to the active one", async ({
    page,
  }) => {
    // The other half of a stale bookmark: this one passes every validation and simply is not on
    // the board any more, so nothing refuses it — resolveSelectedSprint is the only thing that can
    const deleted = String(LIFECYCLE_PAST_ONE_ID).replace(/.$/, "9");
    expect(deleted).not.toBe(String(LIFECYCLE_PAST_ONE_ID));

    await signIn(page);
    await openSprints(page, `?sprint=${deleted}`);

    await expect(selectedSprintName(page)).toHaveText(LIFECYCLE_CURRENT_NAME);
    await expect(page).toHaveURL(new RegExp(`sprint=${LIFECYCLE_CURRENT_ID}`));
  });
});
