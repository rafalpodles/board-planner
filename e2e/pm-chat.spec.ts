import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
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
import { signIn, signInContext } from "./session";
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

/** What the model was handed on the last turn — see the stub's /last. */
async function lastRequest(request: APIRequestContext): Promise<{
  userBlocks: string[];
  images: number;
  systemLines: number;
  roles: string[];
}> {
  const res = await request.get(`${PM_STUB_URL}/last`);
  return res.json();
}

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

test.describe("a turn somebody else is running", () => {
  test("is refused without wedging the second reader's composer shut", async ({ page, browser }) => {
    // BP-452. The 409 used to put this reader into the recovery state, which only ever exits when
    // an assistant message lands in *their own* thread — and threads are private, so the turn that
    // caused the refusal can never end it. Box disabled, Send replaced by a Stop that is refused
    // in silence, and what was typed gone. Only a reload got you out.
    await signIn(page, "admin");
    await openChat(page);
    await say(page, "Hold the line.", { delayMs: 30_000, say: "Eventually." });
    await expect(page.getByText("PM is thinking…")).toBeVisible();

    const other = await browser.newContext();
    await signInContext(other, "member");
    const second = await other.newPage();
    try {
      await second.goto(PM_URL);
      await expect(chatBox(second)).toBeVisible();

      const [refusal] = await Promise.all([
        second.waitForResponse(
          (r) => r.request().method() === "POST" && r.url().includes("/pm/chat")
        ),
        (async () => {
          await chatBox(second).fill("Mine now, please.");
          await sendButton(second).click();
        })(),
      ]);
      expect(refusal.status(), "the second sender did not get the refusal this test is about").toBe(
        409
      );

      // The refusal is on screen, and it is the server's sentence rather than a recovery notice
      await expect(second.getByText(/Someone is already talking to the PM agent/)).toBeVisible();

      // ...and the composer is still a composer
      await expect(chatBox(second)).toBeEnabled();
      await expect(sendButton(second)).toBeVisible();
      await expect(second.getByRole("button", { name: "Stop the PM turn" })).toHaveCount(0);

      // What was typed is recoverable, and the message that was never sent is not left on screen
      await expect(second.getByRole("button", { name: "Retry" })).toBeVisible();
      await expect(bubbles(second).filter({ hasText: "Mine now, please." })).toHaveCount(0);
    } finally {
      await other.close();
    }

    // The control for the refusal above: this reader owns the turn, so their Stop is allowed where
    // the second reader's was not. It also releases the lock, which is in-process — leaving it
    // would 409 the next test in this file for the rest of the 30s delay.
    await page.getByRole("button", { name: "Stop the PM turn" }).click();
    await expect(page.getByText("⏹ Stopped by user.")).toBeVisible();
    await expect(sendButton(page)).toBeVisible();
  });
});

test.describe("a stream that dies mid-turn", () => {
  test("stops blocking the box after 30s, without giving up on the answer", async ({ page }) => {
    // BP-452's second door: a stream that ends with no `done` and no `error` frame.
    //
    // The route is truncated rather than the server killed, so this reaches the `!finished` branch
    // and not the reader's `catch`; the request never leaves the browser, so no turn starts and the
    // poll reads an empty thread. That is a narrower situation than a server dying mid-turn, and
    // enough for what is under test here: the poll used to have no end at all.
    //
    // The 300s give-up is not driven — it matches the route's own maxDuration, and a test that sat
    // out five minutes to watch it would cost more than it proves.
    await signIn(page);
    await openChat(page);

    // Poison `lastFailedInput` first. Without this the "no Retry" assertion at the end is a dial
    // that cannot move: it was only ever passing because nothing had failed earlier in the test,
    // and `lastFailedInput` was never cleared once written.
    await say(page, "This one will not go through.", { status: 500 });
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

    await page.route("**/pm/chat", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: 'event: action\ndata: {"summary":"Reading the board"}\n\n',
      });
    });

    await chatBox(page).fill("Say something.");
    await sendButton(page).click();

    await expect(page.getByText("Connection lost — recovering the answer…")).toBeVisible();
    // The control: while it is still inside the blocking window the box stays shut, which is
    // correct — the complaint was that it never stopped.
    await expect(chatBox(page)).toBeDisabled();

    await expect(
      page.getByText(/The connection dropped\. The turn may still be running/)
    ).toBeVisible({ timeout: 60_000 });
    await expect(chatBox(page)).toBeEnabled();
    await expect(sendButton(page)).toBeVisible();

    // Deliberately no Retry, unlike the 409 above: there the turn never started, here it may well
    // be running or finished, and re-sending would spend a second turn against the cap. This
    // assertion is only worth anything because `lastFailedInput` is now cleared on each send — it
    // used to hold whatever had failed last, so it could offer Retry for an unrelated message.
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  });
});

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

  test("an image on its own is a message, with nothing typed", async ({ page, request }) => {
    // BP-451, reachable on a first attempt: paste a screenshot, press Send, and the image was gone
    // — the button offered it and the server refused with a validation sentence written for an API
    // client. No directive is typed here, so the stub answers with its fallback; that is the point.
    await pmSettings({ model: "e2e/vision-model" });
    await signIn(page);
    await openChat(page);

    await attach(page);
    await expect(page.getByAltText("Attachment preview")).toBeVisible();
    await expect(chatBox(page)).toHaveValue("");

    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === "POST" && r.url().includes("/pm/chat")
      ),
      sendButton(page).click(),
    ]);
    expect(response.status(), await response.text()).toBe(200);

    await expect(reply(page)).toContainText("Noted.");
    await expect(page.getByAltText("Attached screenshot").first()).toBeVisible();

    // The assertion the reply cannot make. "Noted." is what any turn answers, so on its own it
    // certifies that a turn ran, not that the picture was in it — a buildUserContent that returned
    // the text unconditionally left every test in this file green (BP-451 review).
    const sent = await lastRequest(request);
    expect(sent.userBlocks, "the image never reached the model").toContain("image_url");
    expect(sent.userBlocks, "an empty text block went with it").not.toContain("empty-text");
    expect(sent.images).toBe(1);
  });

  test("the picture is still there on the next turn, when the question arrives", async ({
    page,
    request,
  }) => {
    // The follow-up is the point of sending a screenshot at all, and it is where the replay guard
    // dropped it: history was replayed only `if (content)`, and an image-only turn has none.
    await pmSettings({ model: "e2e/vision-model" });
    await signIn(page);
    await openChat(page);

    await attach(page);
    await sendButton(page).click();
    await expect(reply(page)).toContainText("Noted.");

    await say(page, "What is wrong with it?", { say: "The pixel is white." });
    await expect(reply(page)).toContainText("The pixel is white.");

    const sent = await lastRequest(request);
    expect(sent.userBlocks, "the follow-up itself carries no image").toEqual(["text"]);
    expect(sent.images, "the screenshot was dropped from history").toBe(1);
    expect(sent.roles.filter((r) => r === "user")).toHaveLength(2);
  });

  test("a refused send hands the picture back instead of destroying it", async ({ page }) => {
    // The other half of BP-451, and it survives whichever end of the argument wins: the thumbnails
    // were cleared on the way out rather than on success, so a refusal left the upload sitting in
    // GridFS with nothing on screen able to reach it.
    await pmSettings({ model: "e2e/text-only-model" });
    await signIn(page);
    await openChat(page);

    await attach(page);
    await expect(page.getByAltText("Attachment preview")).toBeVisible();
    const [first] = await Promise.all([
      page.waitForRequest((r) => r.method() === "POST" && r.url().includes("/pm/chat")),
      sendButton(page).click(),
    ]);

    await expect(
      page.getByText(/does not accept images/)
    ).toBeVisible();
    // Still there, and offered again — Retry used to be keyed on the typed text, which is empty
    // for an image-only send
    await expect(page.getByAltText("Attachment preview")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    // ...and the message that never went is not left in the thread
    await expect(agentSpoke(page)).toHaveCount(0);

    // A thumbnail is not the picture. Clicking Retry is what proves the restored attachment is the
    // same upload and still usable — a restore that handed back previews with rewritten fileIds
    // read identically to this one (BP-451 review).
    const [second] = await Promise.all([
      page.waitForRequest((r) => r.method() === "POST" && r.url().includes("/pm/chat")),
      page.getByRole("button", { name: "Retry" }).click(),
    ]);
    expect(JSON.parse(second.postData() ?? "{}").attachments).toEqual(
      JSON.parse(first.postData() ?? "{}").attachments
    );
  });

  test("a turn that fails mid-stream offers no Retry when it carried a picture", async ({
    page,
  }) => {
    // Unlike a refusal, this turn ran: its images are on the persisted message, so resending would
    // upload them again, and resending the text without them is not a retry. Before the review this
    // branch offered a Retry here that called send("") and did nothing at all.
    await pmSettings({ model: "e2e/vision-model" });
    await signIn(page);
    await openChat(page);

    await attach(page);
    await say(page, "Look at this.", { status: 500 });

    await expect(reply(page)).toContainText(/⚠️ OpenRouter HTTP 500/);
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(chatBox(page)).toBeEnabled();
  });

  test("an image-only send whose image cannot be read is refused, not turned into an empty turn",
    async ({ page, request }) => {
    // Found reviewing this branch's own change. Everything the route checks above is the *shape* of
    // an attachment, so a well-formed fileId naming no file passed — and with no text either, the
    // turn reached the provider with an empty user content, spending one against the daily cap.
    // Driven over the API because the composer can only offer files it has just uploaded.
    await pmSettings({ model: "e2e/vision-model" });
    await signIn(page);

    const response = await request.post(`/api/projects/${PROJECT_KEY}/pm/chat`, {
      headers: ADMIN_AUTH,
      data: {
        message: "",
        attachments: [{ fileId: "0123456789abcdef01234567", mimeType: "image/png" }],
      },
    });
    expect(response.status(), await response.text()).toBe(400);
    expect(await response.text()).toContain("That image could not be read");

    // The control: the same shape with a real upload behind it is a turn, not a refusal — covered
    // by "an image on its own is a message" above, which goes through the composer.
    expect(
      await withDb(async (db) => db.collection("pmmessages").countDocuments({ project: PROJECT_ID }))
    ).toBe(0);
  });

  test("more images than the cap says how many it took", async ({ page }) => {
    await signIn(page);
    await openChat(page);

    await page.setInputFiles(
      'input[type="file"]',
      Array.from({ length: 6 }, (_, i) => ({
        name: `shot-${i}.png`,
        mimeType: "image/png",
        buffer: PNG,
      }))
    );

    await expect(page.getByText("Attached 4 of 6 — 4 images per message.")).toBeVisible();
    await expect(page.getByAltText("Attachment preview")).toHaveCount(4);
  });

  test("the cap counts what is already attached, and says so", async ({ page }) => {
    // The case above has 4 taken and a cap of 4, so the two numbers are the same and swapping them
    // would be invisible. Here they differ, and the sentence has to explain why only one landed.
    await signIn(page);
    await openChat(page);

    await page.setInputFiles(
      'input[type="file"]',
      Array.from({ length: 3 }, (_, i) => ({
        name: `first-${i}.png`,
        mimeType: "image/png",
        buffer: PNG,
      }))
    );
    await expect(page.getByAltText("Attachment preview")).toHaveCount(3);

    await page.setInputFiles(
      'input[type="file"]',
      Array.from({ length: 2 }, (_, i) => ({
        name: `more-${i}.png`,
        mimeType: "image/png",
        buffer: PNG,
      }))
    );

    await expect(
      page.getByText("Attached 1 of 2 — 4 images per message, and 3 already attached.")
    ).toBeVisible();
    await expect(page.getByAltText("Attachment preview")).toHaveCount(4);
  });

  test("a composer already at the cap says how many are there, not just the limit", async ({
    page,
  }) => {
    await signIn(page);
    await openChat(page);

    await page.setInputFiles(
      'input[type="file"]',
      Array.from({ length: 4 }, (_, i) => ({
        name: `full-${i}.png`,
        mimeType: "image/png",
        buffer: PNG,
      }))
    );
    await expect(page.getByAltText("Attachment preview")).toHaveCount(4);

    await page.setInputFiles('input[type="file"]', {
      name: "one-too-many.png",
      mimeType: "image/png",
      buffer: PNG,
    });

    await expect(
      page.getByText("Attached 0 of 1 — 4 images per message, and 4 already attached.")
    ).toBeVisible();
    await expect(page.getByAltText("Attachment preview")).toHaveCount(4);
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
