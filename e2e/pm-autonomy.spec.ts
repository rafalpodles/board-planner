import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH } from "./api";
import {
  E2E_MONGODB_URI,
  PROJECT_ID,
  PROJECT_KEY,
  SIBLING_TASK_KEY,
  SIBLING_TASK_NUMBER,
  seed,
} from "./seed";
import { signIn } from "./session";

const SETTINGS = `/projects/${PROJECT_KEY}/settings?section=pm`;
const BOARD = `/projects/${PROJECT_KEY}`;

async function withDb<T>(fn: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  const dbName = new URL(E2E_MONGODB_URI.replace(/^mongodb/, "http")).pathname.slice(1);
  if (!dbName.endsWith("_e2e")) {
    throw new Error(`Refusing to touch database "${dbName}": this fixture only runs against *_e2e`);
  }
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    const handle = mongoose.connection.db;
    if (!handle) throw new Error("no database handle");
    return await fn(handle);
  } finally {
    await mongoose.disconnect();
  }
}

async function pmSettings(over: Record<string, unknown>) {
  await withDb(async (db) => {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(over)) set[`pm.${key}`] = value;
    await db.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: set });
  });
}

async function storedPm(): Promise<Record<string, unknown>> {
  return withDb(async (db) => {
    const project = await db.collection("projects").findOne({ _id: PROJECT_ID });
    return (project?.pm ?? {}) as Record<string, unknown>;
  });
}

test.beforeEach(seed);

const scheduleSwitch = (page: Page) =>
  page.getByRole("switch", { name: "Review the board on a schedule" });
const escalationSwitch = (page: Page) =>
  page.getByRole("switch", { name: 'Review tasks that land in "Needs human review"' });

const reviewInterval = (page: Page) => page.getByLabel("How often");

async function flip(toggle: ReturnType<typeof scheduleSwitch>) {
  await toggle.locator("xpath=ancestor::label[1]").click();
}

async function openPmSettings(page: Page) {
  await page.goto(SETTINGS);
  await expect(page.getByRole("heading", { name: "When it acts on its own" })).toBeVisible();
}

async function saveSettings(page: Page) {
  const saved = page.waitForResponse(
    (r) => r.request().method() === "PUT" && r.url().includes("/api/projects/") && r.ok()
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  await saved;
}

test.describe("the autonomy form", () => {
  test("keeps the schedule out of sight until the schedule is switched on", async ({ page }) => {
    await signIn(page);
    await openPmSettings(page);

    await expect(scheduleSwitch(page)).not.toBeChecked();
    await expect(page.getByLabel("First review at")).toHaveCount(0);
    await expect(page.getByLabel("Timezone")).toHaveCount(0);

    await flip(scheduleSwitch(page));

    await expect(page.getByLabel("First review at")).toBeVisible();
    await expect(reviewInterval(page)).toBeVisible();
    await expect(page.getByLabel("Timezone")).toBeVisible();
  });

  test("says when the reviews will actually happen, counted in the browser", async ({ page }) => {
    await signIn(page);
    await openPmSettings(page);
    await flip(scheduleSwitch(page));

    await expect(page.getByText(/One review a day, at 09:00 in Europe\/Warsaw/)).toBeVisible();

    await reviewInterval(page).selectOption("12");
    await expect(page.getByText(/2 reviews a day, at 09:00, 21:00 in Europe\/Warsaw/)).toBeVisible();

    await page.getByLabel("First review at").fill("7");
    await expect(page.getByText(/2 reviews a day, at 07:00, 19:00 in Europe\/Warsaw/)).toBeVisible();

    await reviewInterval(page).selectOption("6");
    await expect(
      page.getByText(/3 reviews a day, at 07:00, 13:00, 19:00 in Europe\/Warsaw/)
    ).toBeVisible();
  });

  test("saves the schedule, and the project holds what the form said", async ({ page }) => {
    await signIn(page);
    await openPmSettings(page);

    await flip(scheduleSwitch(page));
    await page.getByLabel("First review at").fill("7");
    await reviewInterval(page).selectOption("12");
    await page.getByLabel("Timezone").fill("Europe/London");
    await saveSettings(page);

    const pm = await storedPm();
    expect(pm.autonomy).toMatchObject({
      dailyReview: true,
      reviewHour: 7,
      reviewIntervalHours: 12,
      timezone: "Europe/London",
    });

    await page.reload();
    await expect(scheduleSwitch(page)).toBeChecked();
    await expect(page.getByLabel("First review at")).toHaveValue("7");
    await expect(page.getByLabel("Timezone")).toHaveValue("Europe/London");
  });

  test("refuses a timezone the server cannot read, at the field, before the save", async ({
    page,
  }) => {
    await signIn(page);
    await openPmSettings(page);
    await flip(scheduleSwitch(page));

    await page.getByLabel("Timezone").fill("Europe/London");
    await expect(page.getByText(/in Europe\/London/)).toBeVisible();

    await page.getByLabel("Timezone").fill("Warsaw");
    await expect(page.getByText("Not a timezone this server knows: Warsaw")).toBeVisible();
    await expect(page.getByText(/in Warsaw/)).toHaveCount(0);
    await expect(page.getByText(/reviews? a day/)).toHaveCount(0);
    await expect(page.getByText(/Name a timezone this server knows/)).toBeVisible();

    let sent = 0;
    page.on("request", (r) => {
      if (r.method() === "PUT" && r.url().includes("/api/projects/")) sent += 1;
    });
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForTimeout(700);
    expect(sent, "the form posted a body the server would refuse").toBe(0);

    await page.getByLabel("Timezone").fill("Europe/London");
    await saveSettings(page);
    expect(sent, "the listener never observes a PUT, so the zero above proves nothing").toBe(1);
  });

  test("an emptied timezone is refused too, and is not what gets posted", async ({ page }) => {
    await signIn(page);
    await openPmSettings(page);
    await flip(scheduleSwitch(page));

    await page.getByLabel("Timezone").fill("");
    await expect(page.getByText(/A review has to run somewhere/)).toBeVisible();
  });

  test("an unreadable timezone stops mattering once the schedule is off", async ({ page }) => {
    await signIn(page);
    await openPmSettings(page);

    await flip(scheduleSwitch(page));
    await page.getByLabel("Timezone").fill("Warsaw");
    await expect(page.getByText(/Not a timezone this server knows/)).toBeVisible();

    await flip(scheduleSwitch(page));
    await saveSettings(page);

    const stored = (await storedPm()) as { autonomy: { timezone: string } };
    expect(stored.autonomy.timezone).toBe("Europe/Warsaw");
  });

  test("refuses a turn cap that is not a whole number in range", async ({ page }) => {
    await signIn(page);
    await openPmSettings(page);

    const cap = page.getByLabel("Turns per day");
    await cap.fill("40");
    await expect(page.getByText(/whole number of turns/)).toHaveCount(0);
    await saveSettings(page);
    expect((await storedPm()).dailyTurnCap).toBe(40);

    for (const bad of ["12.5", "-1", "1001"]) {
      await cap.fill(bad);
      await expect(page.getByText(/whole number of turns/), bad).toBeVisible();
    }

    let sent = 0;
    page.on("request", (r) => {
      if (r.method() === "PUT" && r.url().includes("/api/projects/")) sent += 1;
    });
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForTimeout(700);
    expect(sent).toBe(0);
    expect((await storedPm()).dailyTurnCap).toBe(40);
  });

  test("the turn-cap hint names the board's own day, and follows it when it changes", async ({
    page,
  }) => {
    await signIn(page);
    await openPmSettings(page);

    const hint = page.getByText(/Resets at midnight in/);
    await expect(hint).toContainText("Europe/Warsaw");
    await expect(hint).toContainText("a turn the model failed");

    await flip(scheduleSwitch(page));
    await page.getByLabel("Timezone").fill("Asia/Tokyo");
    await saveSettings(page);
    await page.reload();

    await expect(page.getByText(/Resets at midnight in/)).toContainText("Asia/Tokyo");
    await expect(page.getByText(/Resets at midnight in/)).not.toContainText("Europe/Warsaw");
  });

  test("saves the escalation switch on its own", async ({ page }) => {
    await signIn(page);
    await openPmSettings(page);

    await expect(escalationSwitch(page)).not.toBeChecked();
    await flip(escalationSwitch(page));
    await saveSettings(page);

    const pm = await storedPm();
    expect((pm.autonomy as Record<string, unknown>).handleNeedsHumanReview).toBe(true);
    expect((pm.autonomy as Record<string, unknown>).dailyReview).toBe(false);
  });
});

test.describe("a task that lands in Needs Human Review", () => {
  async function escalate(page: Page) {
    await page.goto(BOARD);
    await expect(page.getByRole("heading", { name: /E2E Run Conflict Board/ })).toBeVisible();
    const card = page.locator(`a[href="/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}"]`);
    await expect(card).toBeVisible();
    await card.click({ button: "right" });
    await page
      .getByTestId("task-context-menu")
      .getByRole("button", { name: "Needs Human Review", exact: true })
      .click();
    await expect(page.getByTestId("column-needs_human_review").locator(`a[href*="/tasks/${SIBLING_TASK_NUMBER}"]`)).toBeVisible();
  }

  async function comments(page: Page): Promise<{ body: string; author: string }[]> {
    const task = await page.request.get(
      `/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`,
      { headers: ADMIN_AUTH }
    );
    const { _id } = await task.json();
    const res = await page.request.get(
      `/api/projects/${PROJECT_KEY}/tasks/${_id}/comments`,
      { headers: ADMIN_AUTH }
    );
    const rows = (await res.json()) as { body: string; author?: { fullName?: string } }[];
    return rows.map((r) => ({ body: r.body, author: r.author?.fullName ?? "" }));
  }

  test("is reviewed by the agent, which answers in a comment", async ({ page }) => {
    await pmSettings({ "autonomy.handleNeedsHumanReview": true });
    await signIn(page);
    await escalate(page);

    await expect
      .poll(async () => (await comments(page)).map((c) => `${c.author}: ${c.body}`), {
        timeout: 30_000,
      })
      .toEqual(["PM Agent: Reviewed on the way in: this is answerable from the board."]);

    await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
    await expect(
      page.getByText("Reviewed on the way in: this is answerable from the board.")
    ).toBeVisible();
    await expect(page.getByText("PM Agent").first()).toBeVisible();
  });

  test("and the review is announced in the chat as an automatic one", async ({ page }) => {
    await pmSettings({ "autonomy.handleNeedsHumanReview": true });
    await signIn(page);
    await escalate(page);

    await expect
      .poll(async () => (await comments(page)).length, { timeout: 30_000 })
      .toBe(1);

    await page.goto(`/projects/${PROJECT_KEY}/pm`);
    const mark = page.getByText(`Auto review: ${SIBLING_TASK_KEY}`);
    await expect(mark.first()).toBeVisible();
    await expect(mark).toHaveCount(2);
  });

  test("is reviewed once, and a person moving it on is what ends it", async ({ page }) => {
    await pmSettings({ "autonomy.handleNeedsHumanReview": true });
    await signIn(page);
    await escalate(page);
    await expect.poll(async () => (await comments(page)).length, { timeout: 30_000 }).toBe(1);

    await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
    await expect(
      page.getByText("Reviewed on the way in: this is answerable from the board.")
    ).toBeVisible();
    await expect(page.getByText("PM Agent").first()).toBeVisible();

    await page.goto(BOARD);
    const card = page.locator(`a[href="/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}"]`);
    await card.click({ button: "right" });
    await page
      .getByTestId("task-context-menu")
      .getByRole("button", { name: "Ready to Test", exact: true })
      .click();
    await expect(
      page.getByTestId("column-ready_to_test").locator(`a[href*="/tasks/${SIBLING_TASK_NUMBER}"]`)
    ).toBeVisible();

    await page.waitForTimeout(8_000);
    expect(await comments(page)).toHaveLength(1);
  });

  test("is left alone when the switch is off", async ({ page }) => {
    await signIn(page);
    await escalate(page);

    await page.waitForTimeout(8_000);
    expect(await comments(page)).toEqual([]);

    await page.goto(`/projects/${PROJECT_KEY}/pm`);
    await expect(
      page.getByText(
        "Talk to the PM: ask it to break a feature into tasks, refine a backlog or report on project state."
      )
    ).toBeVisible();
    await expect(page.getByText(/Auto review:/)).toHaveCount(0);
  });
});

test.describe("when the agent is not available", () => {
  test("a project with the agent switched off says so, and offers the way to switch it on", async ({
    page,
  }) => {
    await pmSettings({ enabled: false });
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/pm`);

    await expect(
      page.getByText("The PM agent is disabled for this project — enable it in settings.")
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to settings" })).toBeVisible();
    await expect(page.getByPlaceholder(/Message the PM/)).toHaveCount(0);
  });

  test("an instance lock says so, and deliberately offers no link", async ({ page }) => {
    await pmSettings({ lockedByInstance: true });
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/pm`);

    await expect(page.getByText(/cannot be re-enabled from project settings/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to settings" })).toHaveCount(0);
    await expect(page.getByPlaceholder(/Message the PM/)).toHaveCount(0);
  });
});

test.describe("the chat that follows you around", () => {
  const fab = (page: Page) => page.getByRole("button", { name: /PM chat$/ });

  test("opens from the board and answers there, and is absent on the PM page itself", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(BOARD);

    const opener = page.getByRole("button", { name: "Open PM chat" });
    await expect(opener).toBeVisible();
    await opener.click();

    await expect(page.getByText(/^🤖 PM — /)).toBeVisible();
    const box = page.getByPlaceholder(/Message the PM/);
    await box.fill('From the widget <<{"say":"Answered in the corner."}>>');
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      page.getByText("PM Agent", { exact: true }).last().locator("xpath=..")
    ).toContainText("Answered in the corner.");

    await page.getByRole("button", { name: "Close PM chat" }).first().click();
    await expect(page.getByText(/^🤖 PM — /)).toHaveCount(0);

    await page.goto(`/projects/${PROJECT_KEY}/pm`);
    await expect(page.getByPlaceholder(/Message the PM/)).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(fab(page)).toHaveCount(0);
  });

  test("is not offered at all when the agent is switched off", async ({ page }) => {
    await pmSettings({ enabled: false });
    await signIn(page);
    await page.goto(BOARD);
    await expect(page.getByRole("heading", { name: /E2E Run Conflict Board/ })).toBeVisible();

    await page.waitForLoadState("networkidle");
    await expect(fab(page)).toHaveCount(0);
  });
});
