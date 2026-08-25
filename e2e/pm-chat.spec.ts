import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH } from "./api";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  PROJECT_ID,
  PROJECT_KEY,
  SIBLING_TASK_KEY,
  SIBLING_TASK_NUMBER,
  seed,
} from "./seed";
import { signIn } from "./session";
import { PM_STUB_URL } from "../playwright.config";

/**
 * BP-391. The PM chat is the one surface where the product talks back, and until now the only
 * thing driving it end to end was two tests in `field-history.spec.ts` that cared about who the
 * board credited for a field change — the chat was the vehicle, never the subject.
 *
 * Everything here runs against the real chat box, the real SSE stream, the real agent loop and
 * the real tool dispatch. Only the model is replaced (`e2e/openrouter-stub.mjs`), and what it
 * "decides" travels inside the message the test types, between << and >>, so no fixture stands
 * in for a turn.
 *
 * The stub also scripts how the *provider* behaves — a 500, a stall, a first-attempt failure,
 * and the /models list `modelAcceptsImages` reads. Those are the branches a person only meets on
 * a bad day, and they are exactly the ones nothing was watching.
 */

const PM_URL = `/projects/${PROJECT_KEY}/pm`;

/** A 1x1 PNG, small enough to live in the file and real enough for the image pipeline. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

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

/** Whatever the project's `pm` subdocument should say for this test. */
async function pmSettings(over: Record<string, unknown>) {
  await withDb(async (db) => {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(over)) set[`pm.${key}`] = value;
    await db.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: set });
  });
}

/** Turns already spent today, which is all `isOverDailyTurnCap` counts. */
async function spendTurns(count: number) {
  await withDb(async (db) => {
    await db.collection("pmmessages").insertMany(
      Array.from({ length: count }, (_, i) => ({
        project: PROJECT_ID,
        role: "user",
        content: `spent turn ${i + 1}`,
        actions: [],
        attachments: [],
        trigger: { type: "chat", taskKey: "" },
        triggeredBy: ADMIN_ID,
        createdAt: new Date(),
      }))
    );
  });
}

test.beforeEach(async ({ request }) => {
  await seed();
  // The stub counts attempts per directive and outlives the whole run, so a Playwright retry
  // would start the `failTimes` test at attempt 2 — no failure, no Retry button, and a red that
  // has nothing to do with the product.
  await request.post(`${PM_STUB_URL}/reset`);
});

const chatBox = (page: Page) => page.getByPlaceholder(/Message the PM/);
const sendButton = (page: Page) => page.getByRole("button", { name: "Send", exact: true });

/** Every message bubble in the thread, oldest first. */
const bubbles = (page: Page) => page.locator("div.prose-sm");

/**
 * The agent's own bubble, and nothing else.
 *
 * This scoping is load-bearing rather than tidy. The message a test types **contains the
 * directive that scripts the answer**, so `page.getByText("...")` matches what the tester wrote
 * and passes whether or not the agent ever said a word. Five tests in the first draft of this
 * file passed that way, including one whose whole subject was that a refusal produces no reply.
 */
const reply = (page: Page) => page.getByText("PM Agent", { exact: true }).last().locator("xpath=..");

/** Whether the agent produced a bubble at all — how a refusal is told from an answer. */
const agentSpoke = (page: Page) => page.getByText("PM Agent", { exact: true });

async function openChat(page: Page) {
  await page.goto(PM_URL);
  await expect(chatBox(page)).toBeVisible();
}

/** Types a message carrying its own directive and sends it. */
async function say(page: Page, prompt: string, directive: Record<string, unknown>) {
  await chatBox(page).fill(`${prompt} <<${JSON.stringify(directive)}>>`);
  await sendButton(page).click();
}

test.describe("a turn, from the box to the bubble", () => {
  test("an empty thread says what the agent is for", async ({ page }) => {
    await signIn(page);
    await openChat(page);

    await expect(
      page.getByText(
        "Talk to the PM: ask it to break a feature into tasks, refine a backlog or report on project state."
      )
    ).toBeVisible();
    await expect(bubbles(page)).toHaveCount(0);
  });

  test("the answer arrives under the agent's name and survives a reload", async ({ page }) => {
    await signIn(page);
    await openChat(page);

    await say(page, "How is the board looking?", { say: "Four cards, one of them held." });

    await expect(reply(page)).toContainText("Four cards, one of them held.");
    await expect(page.getByText("How is the board looking?")).toBeVisible();

    // The chat is a thread, not a transcript of this page load
    await page.reload();
    await expect(reply(page)).toContainText("Four cards, one of them held.");
    await expect(page.getByText("How is the board looking?")).toBeVisible();
  });

  test("a tool call is reported as a chip that links to the task it touched", async ({ page }) => {
    await signIn(page);
    await openChat(page);

    await say(page, "Please rename that one.", {
      name: "update_task",
      arguments: { taskKey: SIBLING_TASK_KEY, title: "Renamed by the agent" },
    });

    const chip = page.getByRole("link", { name: new RegExp(SIBLING_TASK_KEY) });
    await expect(chip).toBeVisible();

    // Followed rather than read: the task page accepts both `3` and `TP-3`, and which of the two
    // the chip happens to carry is not the promise. That it lands on the task is.
    await chip.click();
    await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Renamed by the agent");

    // And the chip is a claim about the board, so the board is asked too
    const task = await page.request.get(
      `/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`,
      { headers: ADMIN_AUTH }
    );
    expect((await task.json()).title).toBe("Renamed by the agent");
  });

  test("while a turn runs the box is closed, and Send becomes Stop", async ({ page }) => {
    await signIn(page);
    await openChat(page);

    await say(page, "Take your time.", { delayMs: 4000, say: "Finished eventually." });

    await expect(page.getByText("PM is thinking…")).toBeVisible();
    await expect(chatBox(page)).toBeDisabled();
    await expect(sendButton(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop the PM turn" })).toBeVisible();

    await expect(reply(page)).toContainText("Finished eventually.", { timeout: 20_000 });
    await expect(chatBox(page)).toBeEnabled();
    await expect(sendButton(page)).toBeVisible();
  });

  test("a turn can be stopped, and says so in the thread", async ({ page }) => {
    await signIn(page);
    await openChat(page);

    // A minute of stalling against a twenty-second budget: the only way this test can go green is
    // if the interrupt really cuts the request. An earlier version used an eight-second stall and
    // stayed green with the whole /pm/interrupt route deleted, because the turn simply finished.
    await say(page, "Never mind, actually.", { delayMs: 60_000, say: "Too late." });
    await expect(page.getByText("PM is thinking…")).toBeVisible();

    await page.getByRole("button", { name: "Stop the PM turn" }).click();
    await expect(page.getByText("Stopping…")).toBeVisible();

    await expect(reply(page)).toContainText("⏹ Stopped by user.", { timeout: 20_000 });
    await expect(reply(page)).toContainText("No board actions had run yet.");
    await expect(reply(page)).not.toContainText("Too late.");
    await expect(chatBox(page)).toBeEnabled();
    await expect(sendButton(page)).toBeVisible();
  });

  test("what the agent has already done shows while it is still working", async ({ page }) => {
    await signIn(page);
    await openChat(page);

    // The stub holds the answer that *follows* the tool call, so the turn sits in the one state
    // the suite otherwise never sees: the tool has run, its action has streamed over the SSE
    // channel, and the reply has not arrived. Those live chips are a different code path from the
    // ones a finished message carries.
    await say(page, "Rename it and then think about it.", {
      name: "update_task",
      arguments: { taskKey: SIBLING_TASK_KEY, title: "Renamed mid-turn" },
      delayMs: 8000,
    });

    const working = page.getByRole("button", { name: "Stop the PM turn" });
    await expect(working).toBeVisible();
    await expect(page.getByText(new RegExp(SIBLING_TASK_KEY))).toBeVisible();
    // Still working: the chip is streamed, not the finished message being read back
    await expect(working).toBeVisible();

    await expect(reply(page)).toContainText("Done.", { timeout: 20_000 });
  });
});

test.describe("when the model does not answer", () => {
  test("a provider failure is shown, with the status it failed with", async ({ page }) => {
    await signIn(page);
    await openChat(page);

    await say(page, "This one will not go through.", { status: 500 });

    // Twice over, and both are wanted: the banner above the box, and the bubble the turn left
    // behind, so the thread still says what happened when somebody scrolls back to it tomorrow.
    await expect(page.locator("span").filter({ hasText: /^OpenRouter HTTP 500/ })).toBeVisible();
    await expect(reply(page)).toContainText(/⚠️ OpenRouter HTTP 500/);
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByText("PM is thinking…")).toHaveCount(0);
    await expect(chatBox(page)).toBeEnabled();
  });

  test("Retry sends the same message again, and the second attempt lands", async ({ page }) => {
    await signIn(page);
    await openChat(page);

    // The stub fails the first request carrying this directive and behaves on the next
    await say(page, "Once more with feeling.", { failTimes: 1, say: "Second time lucky." });

    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await page.getByRole("button", { name: "Retry" }).click();

    await expect(reply(page)).toContainText("Second time lucky.");
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  });
});

test.describe("the daily turn cap", () => {
  test("names the cap it refused on", async ({ page }) => {
    await pmSettings({ dailyTurnCap: 3 });
    await spendTurns(3);
    await signIn(page);
    await openChat(page);

    await say(page, "One more, please.", { say: "the cap should stop this" });

    await expect(page.getByText("Daily PM turn cap (3) reached for this project")).toBeVisible();
    // The refusal happens before the agent is ever asked, so there is no reply of any kind
    await expect(agentSpoke(page)).toHaveCount(0);
  });

  test("and lets the turn through when there is room", async ({ page }) => {
    // The control: same board, same message, one turn short of the cap
    await pmSettings({ dailyTurnCap: 3 });
    await spendTurns(2);
    await signIn(page);
    await openChat(page);

    await say(page, "One more, please.", { say: "Room for this one." });

    await expect(reply(page)).toContainText("Room for this one.");
    await expect(page.getByText(/Daily PM turn cap/)).toHaveCount(0);
  });
});

test.describe("attaching a screenshot", () => {
  async function attach(page: Page) {
    await page.setInputFiles('input[type="file"]', {
      name: "shot.png",
      mimeType: "image/png",
      buffer: PNG,
    });
  }

  test("an attachment is previewed with its token cost, and can be taken back off", async ({
    page,
  }) => {
    await signIn(page);
    await openChat(page);

    await attach(page);

    const preview = page.getByAltText("Attachment preview");
    await expect(preview).toBeVisible();
    // The estimate is the browser's own arithmetic over the resized image, not the server's
    await expect(page.getByText(/~\d[\d,]* tok/)).toBeVisible();

    await page.getByRole("button", { name: "Remove attachment" }).click();
    await expect(preview).toHaveCount(0);
    await expect(page.getByText(/~\d[\d,]* tok/)).toHaveCount(0);
  });

  test("a model that cannot read images refuses the attachment, and says which model", async ({
    page,
  }) => {
    await pmSettings({ model: "e2e/text-only-model" });
    await signIn(page);
    await openChat(page);

    await attach(page);
    await expect(page.getByAltText("Attachment preview")).toBeVisible();
    await say(page, "What do you make of this?", { say: "the model should not be asked" });

    await expect(
      page.getByText(/The configured PM model \(e2e\/text-only-model\) does not accept images/)
    ).toBeVisible();
    await expect(agentSpoke(page)).toHaveCount(0);
  });

  test("a model that can read images takes it, and the sent message keeps the picture", async ({
    page,
  }) => {
    // The control for the refusal above: same attachment, same board, a model that reads images
    await pmSettings({ model: "e2e/vision-model" });
    await signIn(page);
    await openChat(page);

    await attach(page);
    await say(page, "What do you make of this?", { say: "A single white pixel." });

    await expect(reply(page)).toContainText("A single white pixel.");
    await expect(page.getByAltText("Attached screenshot").first()).toBeVisible();
    await expect(page.getByText(/does not accept images/)).toHaveCount(0);
  });
});

test.describe("whose conversation it is", () => {
  test("a chat turn belongs to the person who had it, and nobody else", async ({ page, browser }) => {
    await signIn(page);
    await openChat(page);
    await say(page, "Between you and me.", { say: "Understood, just between us." });
    await expect(reply(page)).toContainText("Understood, just between us.");

    // A second reader with a grant on the same board — every right to be here, and still not
    // entitled to somebody else's thread
    const other = await browser.newContext();
    const memberPage = await other.newPage();
    await signIn(memberPage, "member");
    await memberPage.goto(PM_URL);

    await expect(
      memberPage.getByText(
        "Talk to the PM: ask it to break a feature into tasks, refine a backlog or report on project state."
      )
    ).toBeVisible();
    await expect(memberPage.getByText("Understood, just between us.")).toHaveCount(0);
    await expect(memberPage.getByText("Between you and me.")).toHaveCount(0);

    // The control: the admin still has it, so the absence above is about the reader and not
    // about the message having failed to save
    await page.reload();
    await expect(reply(page)).toContainText("Understood, just between us.");

    await other.close();
  });
});
