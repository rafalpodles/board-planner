import { test, expect, type Locator, type Page, type Response } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  CURRENT_SPRINT_ID,
  CURRENT_SPRINT_NAME,
  CURRENT_SPRINT_GOAL,
  PAST_SPRINT_ONE_ID,
  PAST_SPRINT_ONE_NAME,
  PAST_SPRINT_ONE_POINTS,
  PAST_SPRINT_TWO_NAME,
  PAST_SPRINT_TWO_POINTS,
  PLANNED_SPRINT_ID,
  PLANNED_SPRINT_NAME,
  PROJECT_KEY,
  SPRINT_FINISHED_TASK_NUMBER,
  SPRINT_UNFINISHED_TASK_NUMBER,
  demoteDoneColumn,
  seed,
  seedSprintLifecycle,
  storedSprint,
  storedTaskSprint,
} from "./seed";

/**
 * BP-389. Sprints away from the planning drag, which is e2e/sprint-planning.spec.ts: creating and
 * editing one through the form, activating and closing one through the header, the velocity chart
 * on totals a real aggregation produced, and the selected sprint surviving a reload.
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
 * on: this page updates optimistically nowhere, but it does re-render from its own poll, and a
 * name that only ever existed in React state would look identical.
 */

const sprintsUrl = `/projects/${PROJECT_KEY}/sprints`;

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
  return page.getByRole("heading", { level: 2 });
}

/** The status chip beside the sprint's name — Planned, Active or Completed. */
function statusBadge(page: Page): Locator {
  return selectedSprintName(page).locator("xpath=../following-sibling::span[1]");
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
  // Nothing below can run until the page has stopped being a spinner
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
      expect(stored.taskCount).toBe(0);
    });

    await test.step("and a reload finds it there, not only in this tab's state", async () => {
      await page.reload();
      await expect(sprintRow(page, "Sprint Zeppelin")).toBeVisible();
    });
  });

  test("editing renames the sprint on the server, goal included", async ({ page }) => {
    await signIn(page);
    await openSprints(page);
    await expect(selectedSprintName(page)).toHaveText(CURRENT_SPRINT_NAME);

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const form = page.getByRole("dialog", { name: "Edit Sprint" });
    // The form opens on the sprint's own values rather than on a blank or a suggestion
    await expect(form.getByLabel("Name")).toHaveValue(CURRENT_SPRINT_NAME);
    await expect(form.getByLabel("Goal (optional)")).toHaveValue(CURRENT_SPRINT_GOAL);

    await form.getByLabel("Name").fill("Sprint 7 — mast week");
    await form.getByLabel("Goal (optional)").fill("Raise the mast");
    const saved = sprintWrite(page, "PUT");
    await form.getByRole("button", { name: "Update" }).click();
    expect((await saved).status()).toBe(200);

    await expect(selectedSprintName(page)).toHaveText("Sprint 7 — mast week");

    const stored = await storedSprint(CURRENT_SPRINT_ID);
    expect(stored?.name).toBe("Sprint 7 — mast week");
    expect(stored?.goal).toBe("Raise the mast");
    // Untouched fields stay untouched: the form sends all four every time
    expect(stored?.status).toBe("active");

    await page.reload();
    await expect(selectedSprintName(page)).toHaveText("Sprint 7 — mast week");
  });

  test("activating a planned sprint closes the one that was running", async ({ page }) => {
    await signIn(page);
    await openSprints(page, `?sprint=${PLANNED_SPRINT_ID}`);

    await expect(selectedSprintName(page)).toHaveText(PLANNED_SPRINT_NAME);
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
        .getByRole("button", { name: new RegExp(`^${CURRENT_SPRINT_NAME}\\b`) })
    ).toBeVisible();

    expect((await storedSprint(PLANNED_SPRINT_ID))?.status).toBe("active");
    expect((await storedSprint(CURRENT_SPRINT_ID))?.status).toBe("completed");
  });
});

test.describe("closing a sprint from the header", () => {
  test("the dialog counts what is unfinished, and Move to Backlog leaves the finished task behind", async ({
    page,
  }) => {
    await signIn(page);
    await openSprints(page);
    await expect(progress(page)).toHaveText("1/2");

    await page.getByRole("button", { name: "Complete", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Complete Sprint" });
    await expect(dialog).toContainText(`Completing ${CURRENT_SPRINT_NAME}`);
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
      expect(await storedTaskSprint(SPRINT_UNFINISHED_TASK_NUMBER)).toBeNull();
      expect(await storedTaskSprint(SPRINT_FINISHED_TASK_NUMBER)).toBe(String(CURRENT_SPRINT_ID));
      expect((await storedSprint(CURRENT_SPRINT_ID))?.status).toBe("completed");
    });

    await page.reload();
    await expect(statusBadge(page)).toHaveText("Completed");
  });

  test("Keep in Sprint closes it without moving anything", async ({ page }) => {
    await signIn(page);
    await openSprints(page);

    await page.getByRole("button", { name: "Complete", exact: true }).click();
    const closed = sprintWrite(page, "PUT");
    await page
      .getByRole("dialog", { name: "Complete Sprint" })
      .getByRole("button", { name: "Keep in Sprint" })
      .click();
    expect((await closed).status()).toBe(200);

    await expect(statusBadge(page)).toHaveText("Completed");
    // The control for the test above: the same close, the other button, and the unfinished task
    // that moved there stays where it was
    expect(await storedTaskSprint(SPRINT_UNFINISHED_TASK_NUMBER)).toBe(String(CURRENT_SPRINT_ID));
    expect(await storedTaskSprint(SPRINT_FINISHED_TASK_NUMBER)).toBe(String(CURRENT_SPRINT_ID));
    expect((await storedSprint(CURRENT_SPRINT_ID))?.status).toBe("completed");
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

    expect(await storedTaskSprint(SPRINT_UNFINISHED_TASK_NUMBER)).toBeNull();
    expect(await storedTaskSprint(SPRINT_FINISHED_TASK_NUMBER)).toBeNull();
  });
});

test.describe("velocity", () => {
  test("plots the completed sprints' totals, oldest first", async ({ page }) => {
    await signIn(page);
    await openSprints(page);

    await page.getByRole("button", { name: "Velocity" }).click();
    const chart = page.getByRole("img", { name: /^Velocity across completed sprints/ });
    // The numbers are the server's own $convert aggregation over the tasks' Points, not anything
    // this page could have counted
    await expect(chart).toHaveAttribute(
      "aria-label",
      `Velocity across completed sprints: ${PAST_SPRINT_ONE_NAME} ${PAST_SPRINT_ONE_POINTS}, ${PAST_SPRINT_TWO_NAME} ${PAST_SPRINT_TWO_POINTS}`
    );

    // And the bars are drawn to those numbers: the taller one fills the track, the other is
    // 2/8 of it. A chart that reads correctly and draws two equal bars is the failure here.
    const bars = chart.locator("rect");
    await expect(bars).toHaveCount(2);
    await expect(bars.nth(0)).toHaveAttribute("height", "96");
    await expect(bars.nth(1)).toHaveAttribute("height", "24");
  });

  test("with a single completed sprint it says so instead of drawing a chart", async ({
    page,
    request,
  }) => {
    // Reopened through the API rather than reseeded: this is the same board, one sprint short
    const reopened = await request.put(
      `/api/projects/${PROJECT_KEY}/sprints/${PAST_SPRINT_ONE_ID}`,
      { headers: ADMIN_AUTH, data: { status: "planned" } }
    );
    expect(reopened.status()).toBe(200);

    await signIn(page);
    await openSprints(page);

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
      await expect(selectedSprintName(page)).toHaveText(CURRENT_SPRINT_NAME);
      await expect(page).toHaveURL(new RegExp(`sprint=${CURRENT_SPRINT_ID}`));
    });

    await sprintRow(page, PAST_SPRINT_ONE_NAME).click();
    await expect(selectedSprintName(page)).toHaveText(PAST_SPRINT_ONE_NAME);
    await expect(page).toHaveURL(new RegExp(`sprint=${PAST_SPRINT_ONE_ID}`));

    await page.reload();
    await expect(selectedSprintName(page)).toHaveText(PAST_SPRINT_ONE_NAME);
    await expect(sprintRow(page, PAST_SPRINT_ONE_NAME)).toHaveAttribute("aria-current", "true");
  });

  test("a sprint id that is no longer real falls back instead of failing", async ({ page }) => {
    const failed: string[] = [];
    page.on("response", (response) => {
      if (response.status() >= 500) failed.push(`${response.status()} ${response.url()}`);
    });

    await signIn(page);
    // Not an ObjectId at all: /tasks?sprint= casts what it is given straight into a Mongoose
    // filter, so a stale bookmark reaching the fetch is a 500 rather than a fallback
    await openSprints(page, "?sprint=not-a-real-sprint");

    await expect(selectedSprintName(page)).toHaveText(CURRENT_SPRINT_NAME);
    await expect(page).toHaveURL(new RegExp(`sprint=${CURRENT_SPRINT_ID}`));
    expect(failed).toEqual([]);
  });
});
