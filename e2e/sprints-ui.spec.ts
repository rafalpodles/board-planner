import { test, expect, type Locator, type Page, type Response } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  LIFECYCLE_BACKLOG_DONE_TASK_NUMBER,
  LIFECYCLE_BACKLOG_DONE_TASK_TITLE,
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
import { signIn as arriveSignedIn } from "./session";

const sprintsUrl = `/projects/${PROJECT_KEY}/sprints`;
const tasksPath = `/api/projects/${PROJECT_KEY}/tasks`;
const boardApiPrefix = `/api/projects/${PROJECT_KEY}/`;

const signIn = arriveSignedIn;

function sprintList(page: Page): Locator {
  return page.getByRole("navigation", { name: "Sprint list" });
}

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

function planningBacklog(page: Page): Locator {
  return page.getByTestId("planning-pane-backlog");
}

async function openPlanning(page: Page, sprintId: string) {
  await page.goto(`${sprintsUrl}?sprint=${sprintId}&view=planning`);
  await expect(planningBacklog(page)).toBeVisible();
  await expect(planningBacklog(page).getByText("Loading…")).toHaveCount(0);
}

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
    await expect(
      sprintList(page)
        .getByRole("group", { name: "Completed" })
        .getByRole("button", { name: new RegExp(`^${LIFECYCLE_CURRENT_NAME}\\b`) })
    ).toBeVisible();
    await expect(sprintList(page).getByRole("button", { name: /^Show \d+ older/ })).toHaveCount(0);

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
    expect(await storedTaskSprint(LIFECYCLE_UNFINISHED_TASK_NUMBER)).toBe(
      String(LIFECYCLE_CURRENT_ID)
    );
    expect(await storedTaskSprint(LIFECYCLE_FINISHED_TASK_NUMBER)).toBe(
      String(LIFECYCLE_CURRENT_ID)
    );
    expect((await storedSprint(LIFECYCLE_CURRENT_ID))?.status).toBe("completed");
  });

  test("a task in a done column is kept out of the planning backlog", async ({ page }) => {
    await signIn(page);
    await openPlanning(page, String(LIFECYCLE_CURRENT_ID));

    await expect(planningBacklog(page)).not.toContainText(LIFECYCLE_BACKLOG_DONE_TASK_TITLE);
    await expect(
      planningBacklog(page).locator(
        `a[href="/projects/${PROJECT_KEY}/tasks/${LIFECYCLE_BACKLOG_DONE_TASK_NUMBER}"]`
      )
    ).toHaveCount(0);
    await expect(planningBacklog(page).locator("a[href*='/tasks/']").first()).toBeVisible();
  });

  test("on a board with no done column, nothing counts as finished and everything is swept out", async ({
    page,
  }) => {
    await demoteDoneColumn();
    await signIn(page);

    await test.step("the planning backlog offers the task in the column labelled Done", async () => {
      await openPlanning(page, String(LIFECYCLE_CURRENT_ID));
      await expect(
        planningBacklog(page).locator(
          `a[href="/projects/${PROJECT_KEY}/tasks/${LIFECYCLE_BACKLOG_DONE_TASK_NUMBER}"]`
        )
      ).toBeVisible();
    });

    await openSprints(page);
    await expect(page.getByTestId("sprint-progress-unmeasurable")).toHaveText(
      /no Done column/i
    );
    await expect(progress(page)).toHaveCount(0);

    await page.getByRole("button", { name: "Complete", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Complete Sprint" });
    await expect(dialog).toContainText("There are 2 incomplete tasks");

    const closed = sprintWrite(page, "PUT");
    await dialog.getByRole("button", { name: "Move to Backlog" }).click();
    expect((await closed).status()).toBe(200);

    expect(await storedTaskSprint(LIFECYCLE_UNFINISHED_TASK_NUMBER)).toBeNull();
    expect(await storedTaskSprint(LIFECYCLE_FINISHED_TASK_NUMBER)).toBeNull();
    expect((await storedSprint(LIFECYCLE_CURRENT_ID))?.status).toBe("completed");
  });
});

test.describe("velocity", () => {
  test("plots what each completed sprint delivered, oldest first", async ({ page }) => {
    await signIn(page);
    await openSprints(page);

    await page.getByRole("button", { name: "Velocity" }).click();
    const chart = page.getByRole("img", { name: /^Velocity across completed sprints/ });
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
      expect(heights[0] / heights[1]).toBe(
        LIFECYCLE_PAST_ONE_DELIVERED / LIFECYCLE_PAST_TWO_DELIVERED
      );
    });
  });

  test("with a single completed sprint the button is still offered and says why there is no chart", async ({
    page,
    request,
  }) => {
    const reopened = await request.put(
      `/api/projects/${PROJECT_KEY}/sprints/${LIFECYCLE_PAST_ONE_ID}`,
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
    const deleted = String(LIFECYCLE_PAST_ONE_ID).replace(/.$/, "9");
    expect(deleted).not.toBe(String(LIFECYCLE_PAST_ONE_ID));

    await signIn(page);
    await page.goto(`${sprintsUrl}?sprint=${deleted}`);

    await expect(page).toHaveURL(new RegExp(`sprint=${LIFECYCLE_CURRENT_ID}`));
    await expect(selectedSprintName(page)).toHaveText(LIFECYCLE_CURRENT_NAME);
  });
});
