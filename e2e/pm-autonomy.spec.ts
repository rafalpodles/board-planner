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

/**
 * BP-391, the half of the PM agent nobody types into: the settings that let it act unattended,
 * and the one trigger that fires without a person present.
 *
 * The autonomous review is the only turn a test cannot script from the chat box — the prompt is
 * built by the server (`buildNeedsHumanReviewPrompt`), so there is nowhere to put a directive.
 * The stub answers that prompt by its opening line instead, and does the one thing the turn is
 * allowed to do: leave a comment. See the note in `e2e/openrouter-stub.mjs`.
 */

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

/**
 * The interval picker, reached by structure rather than by its label.
 *
 * `Select` renders its `<label>` with no `htmlFor` and does not wrap the control, so the select
 * has no accessible name and `getByLabel("How often")` finds nothing — BP-450. Replace this with
 * `getByLabel` the day that lands.
 */
const reviewInterval = (page: Page) =>
  page.getByText("How often", { exact: true }).locator("xpath=following-sibling::select");

/** The input is `sr-only` under a label that swallows the pointer, so the click goes to the label
 *  — the same way `field-history.spec.ts` drives one. */
async function flip(toggle: ReturnType<typeof scheduleSwitch>) {
  await toggle.locator("xpath=ancestor::label[1]").click();
}

async function openPmSettings(page: Page) {
  await page.goto(SETTINGS);
  await expect(page.getByRole("heading", { name: "When it acts on its own" })).toBeVisible();
}

/**
 * Saves and waits for the server, not for the button.
 *
 * `SaveBar` relabels its button to "Saving..." while the request is in flight, so waiting for
 * "Save changes" to disappear returns at click time and the assertion after it reads the state
 * before the write.
 */
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

    // Nothing on the server produces this sentence: the hours are derived in the page from the
    // first hour and the interval, which is what makes it worth reading here.
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

    // Read back from the server, which is the only thing that settles a save
    const pm = await storedPm();
    expect(pm.autonomy).toMatchObject({
      dailyReview: true,
      reviewHour: 7,
      reviewIntervalHours: 12,
      timezone: "Europe/London",
    });

    // And the form shows it again on the way back in, rather than only in its own state
    await page.reload();
    await expect(scheduleSwitch(page)).toBeChecked();
    await expect(page.getByLabel("First review at")).toHaveValue("7");
    await expect(page.getByLabel("Timezone")).toHaveValue("Europe/London");
  });

  /**
   * BP-454. Both fields accepted values `validatePmConfig` answers 400 for, and the preview line
   * read them back as though it had understood — "…at 09:00, 21:00 in Warsaw" for the typo.
   */
  test("refuses a timezone the server cannot read, at the field, before the save", async ({
    page,
  }) => {
    await signIn(page);
    await openPmSettings(page);
    await flip(scheduleSwitch(page));

    // The control first: a real zone is accepted and the preview names it
    await page.getByLabel("Timezone").fill("Europe/London");
    await expect(page.getByText(/in Europe\/London/)).toBeVisible();

    await page.getByLabel("Timezone").fill("Warsaw");
    await expect(page.getByText("Not a timezone this server knows: Warsaw")).toBeVisible();
    // and the preview stops echoing it back as though it had understood
    await expect(page.getByText(/in Warsaw/)).toHaveCount(0);
    await expect(page.getByText(/cannot read/)).toBeVisible();

    // Nothing is sent: the field already says what is wrong, and a 400 would say it again a
    // round trip later without naming the field
    let sent = false;
    page.on("request", (r) => {
      if (r.method() === "PUT" && r.url().includes("/api/projects/")) sent = true;
    });
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForTimeout(700);
    expect(sent, "the form posted a body the server would refuse").toBe(false);
  });

  test("refuses a turn cap that is not a whole number in range", async ({ page }) => {
    await signIn(page);
    await openPmSettings(page);

    const cap = page.getByLabel("Turns per day");
    // The control: a whole number in range is accepted and saves
    await cap.fill("40");
    await expect(page.getByText(/whole number of turns/)).toHaveCount(0);
    await saveSettings(page);
    expect((await storedPm()).dailyTurnCap).toBe(40);

    for (const bad of ["12.5", "-1", "1001"]) {
      await cap.fill(bad);
      await expect(page.getByText(/whole number of turns/), bad).toBeVisible();
    }

    // and the stored value is still the one that was valid
    expect((await storedPm()).dailyTurnCap).toBe(40);
  });

  test("saves the escalation switch on its own", async ({ page }) => {
    await signIn(page);
    await openPmSettings(page);

    await expect(escalationSwitch(page)).not.toBeChecked();
    await flip(escalationSwitch(page));
    await saveSettings(page);

    const pm = await storedPm();
    expect((pm.autonomy as Record<string, unknown>).handleNeedsHumanReview).toBe(true);
    // The schedule was not touched, so it must not have been switched on alongside
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

  /** The comments on the escalated task, as the API returns them. */
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

    // The drain is fire-and-forget, so this is polled rather than read once
    await expect
      .poll(async () => (await comments(page)).map((c) => `${c.author}: ${c.body}`), {
        timeout: 30_000,
      })
      .toEqual(["PM Agent: Reviewed on the way in: this is answerable from the board."]);

    // And read where a person would read it. The API answer above is the sharp assertion — it can
    // say the comment is the agent's and nobody else's — but a comment nobody can see on the task
    // is not a review, so the page gets its own look.
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
    // Not "Scheduled review", and not a plain chat turn: the thread says where it came from.
    // Both halves of the exchange carry the mark — the server's prompt and the agent's answer —
    // so the whole turn reads as automatic rather than only its reply.
    const mark = page.getByText(`Auto review: ${SIBLING_TASK_KEY}`);
    await expect(mark.first()).toBeVisible();
    await expect(mark).toHaveCount(2);
  });

  test("is reviewed once, and a person moving it on is what ends it", async ({ page }) => {
    await pmSettings({ "autonomy.handleNeedsHumanReview": true });
    await signIn(page);
    await escalate(page);
    await expect.poll(async () => (await comments(page)).length, { timeout: 30_000 }).toBe(1);

    // The person reads it where it was left for them. This is the half of "reviewed by a human"
    // that a status change on its own does not cover: the review has to be legible on the task,
    // under the agent's name, before moving the card means anything.
    await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
    await expect(
      page.getByText("Reviewed on the way in: this is answerable from the board.")
    ).toBeVisible();
    await expect(page.getByText("PM Agent").first()).toBeVisible();

    // ...and only then moves it on, which is the whole point of the column
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

    // Leaving the column is not a second escalation, and nothing reviews it again
    await page.waitForTimeout(8_000);
    expect(await comments(page)).toHaveLength(1);
  });

  test("is left alone when the switch is off", async ({ page }) => {
    // The control. Same board, same move, one switch apart — without it a mis-wired fixture
    // that never triggers anything reads exactly like a working switch.
    //
    // Worth knowing what it does and does not prove: `handleNeedsHumanReview` is read twice, once
    // where the trigger is queued (`triggers.ts:45`) and once where it is run (`:117`). Removing
    // either one alone leaves this test green, and both together turn it red. So it watches the
    // behaviour, not a particular line, and either guard on its own is enough to hold it.
    await signIn(page);
    await escalate(page);

    // The drain starts immediately on the status change rather than on a scheduler tick, and the
    // positive case above has its comment posted within about four seconds. Eight is twice that.
    await page.waitForTimeout(8_000);
    expect(await comments(page)).toEqual([]);

    await page.goto(`/projects/${PROJECT_KEY}/pm`);
    // Anchored on the empty thread: the chat renders a spinner until its messages arrive, and an
    // absence asserted against a spinner is an absence of everything
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
    // Project settings cannot clear an instance lock, so a "Go to settings" link would be a
    // dead end. The absence is the feature, which is why it is asserted rather than assumed.
    await pmSettings({ lockedByInstance: true });
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/pm`);

    await expect(page.getByText(/cannot be re-enabled from project settings/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to settings" })).toHaveCount(0);
    await expect(page.getByPlaceholder(/Message the PM/)).toHaveCount(0);
  });
});

test.describe("the chat that follows you around", () => {
  /**
   * The widget decides whether to draw itself only after it has fetched the project, so a bare
   * `toHaveCount(0)` is satisfied by a widget that has not started rather than by one that chose
   * not to appear — with `onPmPage` forced to false the first version of this test stayed green.
   *
   * Counting `/api/projects/TP` responses was the second version and was no better: `PmChat`
   * alone asks twice on the PM page (once for the project, once from `refreshTaskMap` before the
   * first answer lands), and on the board the page's own request satisfies any threshold the
   * widget was supposed to. So the wait is for the network to go quiet, which is the only signal
   * that covers both.
   */
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

    // Two controls carry that name — the panel's own ✕ and the floating button, whose label
    // flips while the panel is open. The ✕ is the one inside the panel.
    await page.getByRole("button", { name: "Close PM chat" }).first().click();
    await expect(page.getByText(/^🤖 PM — /)).toHaveCount(0);

    // On the full page the button would be a door to the room you are standing in
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

    // Same reason as above: the widget has to have asked before its silence means anything
    await page.waitForLoadState("networkidle");
    await expect(fab(page)).toHaveCount(0);
  });
});
