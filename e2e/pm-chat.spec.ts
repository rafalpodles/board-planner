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

const PM_URL = `/projects/${PROJECT_KEY}/pm`;

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

async function pmSettings(over: Record<string, unknown>) {
  await withDb(async (db) => {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(over)) set[`pm.${key}`] = value;
    await db.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: set });
  });
}

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
  await request.post(`${PM_STUB_URL}/reset`);
});

test.afterEach(async ({ request }) => {
  await request.post(`/api/projects/${PROJECT_KEY}/pm/interrupt`, { headers: ADMIN_AUTH });
});

async function lastRequest(request: APIRequestContext): Promise<{
  userBlocks: string[];
  images: number;
  systems: string[];
  roles: string[];
} | null> {
  const res = await request.get(`${PM_STUB_URL}/last`);
  return res.json();
}

const chatBox = (page: Page) => page.getByPlaceholder(/Message the PM/);
const sendButton = (page: Page) => page.getByRole("button", { name: "Send", exact: true });

const bubbles = (page: Page) => page.locator("div.prose-sm");

const reply = (page: Page) => page.getByText("PM Agent", { exact: true }).last().locator("xpath=..");

const agentSpoke = (page: Page) => page.getByText("PM Agent", { exact: true });

async function openChat(page: Page) {
  await page.goto(PM_URL);
  await expect(chatBox(page)).toBeVisible();
}

async function say(page: Page, prompt: string, directive: Record<string, unknown>) {
  await chatBox(page).fill(`${prompt} <<${JSON.stringify(directive)}>>`);
  await sendButton(page).click();
}

test.describe("a turn somebody else is running", () => {
  test("is refused without wedging the second reader's composer shut", async ({ page, browser }) => {
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

      await expect(second.getByText(/Someone is already talking to the PM agent/)).toBeVisible();

      await expect(chatBox(second)).toBeEnabled();
      await expect(sendButton(second)).toBeVisible();
      await expect(second.getByRole("button", { name: "Stop the PM turn" })).toHaveCount(0);

      await expect(second.getByRole("button", { name: "Retry" })).toBeVisible();
      await expect(bubbles(second).filter({ hasText: "Mine now, please." })).toHaveCount(0);
    } finally {
      await other.close();
    }

    await page.getByRole("button", { name: "Stop the PM turn" }).click();
    await expect(page.getByText("⏹ Stopped by user.")).toBeVisible();
    await expect(sendButton(page)).toBeVisible();
  });
});

test.describe("a stream that dies mid-turn", () => {
  test("stops blocking the box after 30s, without giving up on the answer", async ({ page }) => {
    await signIn(page);
    await openChat(page);

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
    await expect(chatBox(page)).toBeDisabled();

    await expect(
      page.getByText(/The connection dropped\. The turn may still be running/)
    ).toBeVisible({ timeout: 60_000 });
    await expect(chatBox(page)).toBeEnabled();
    await expect(sendButton(page)).toBeVisible();

    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  });
});

test.describe("a turn whose server went away", () => {
  const NOTICE = "⚠️ The connection dropped before this answer finished.";

  async function abandonedTurn(question: string) {
    await withDb(async (db) => {
      const at = new Date();
      await db.collection("pmmessages").insertMany([
        {
          project: PROJECT_ID,
          role: "user",
          content: question,
          actions: [],
          attachments: [],
          trigger: { type: "chat", taskKey: "" },
          triggeredBy: ADMIN_ID,
          createdAt: at,
        },
        {
          project: PROJECT_ID,
          role: "assistant",
          content: "",
          actions: [],
          attachments: [],
          trigger: { type: "chat", taskKey: "" },
          triggeredBy: ADMIN_ID,
          createdAt: at,
        },
      ]);
    });
  }

  test("says what happened instead of sitting there typing for ever", async ({ page }) => {
    await abandonedTurn("Did this one ever finish?");
    await signIn(page);
    await openChat(page);

    await expect(reply(page)).toContainText(NOTICE);
    await expect(reply(page)).not.toContainText("…");

    await page.reload();
    await expect(reply(page)).toContainText(NOTICE);
    await expect(page.getByText("Did this one ever finish?")).toBeVisible();
  });

  test("but a turn that is still running keeps its ellipsis", async ({ page }) => {
    await signIn(page);
    await openChat(page);

    await say(page, "Take your time.", { delayMs: 20_000, say: "Finished in the end." });
    await expect(page.getByText("PM is thinking…")).toBeVisible();

    await expect(async () => {
      await page.reload();
      await expect(reply(page)).toContainText("…", { timeout: 2000 });
    }).toPass({ timeout: 15_000 });
    await expect(page.getByText(NOTICE)).toHaveCount(0);

    await expect(async () => {
      await page.reload();
      await expect(reply(page)).toContainText("Finished in the end.", { timeout: 3000 });
    }).toPass({ timeout: 45_000 });
    await expect(page.getByText(NOTICE)).toHaveCount(0);
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

    await chip.click();
    await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Renamed by the agent");

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

    await say(page, "Rename it and then think about it.", {
      name: "update_task",
      arguments: { taskKey: SIBLING_TASK_KEY, title: "Renamed mid-turn" },
      delayMs: 8000,
    });

    const working = page.getByRole("button", { name: "Stop the PM turn" });
    await expect(working).toBeVisible();
    await expect(page.getByText(new RegExp(SIBLING_TASK_KEY)).first()).toBeVisible();
    await expect(working).toBeVisible();

    await expect(reply(page)).toContainText("Done.", { timeout: 20_000 });
  });
});

test.describe("when the model does not answer", () => {
  test("a provider failure is shown, with the status it failed with", async ({ page }) => {
    await signIn(page);
    await openChat(page);

    await say(page, "This one will not go through.", { status: 500 });

    await expect(page.locator("span").filter({ hasText: /^OpenRouter HTTP 500/ })).toBeVisible();
    await expect(reply(page)).toContainText(/⚠️ OpenRouter HTTP 500/);
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByText("PM is thinking…")).toHaveCount(0);
    await expect(chatBox(page)).toBeEnabled();
  });

  test("Retry sends the same message again, and the second attempt lands", async ({ page }) => {
    await signIn(page);
    await openChat(page);

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
    await expect(agentSpoke(page)).toHaveCount(0);
  });

  test("and lets the turn through when there is room", async ({ page }) => {
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
    expect(response.status(), "the image-only send was refused").toBe(200);

    await expect(reply(page)).toContainText("Noted.");
    await expect(page.getByAltText("Attached screenshot").first()).toBeVisible();

    const sent = await lastRequest(request);
    expect(sent, "no completion request reached the model at all").not.toBeNull();
    expect(sent!.userBlocks, "the image never reached the model").toContain("image_url");
    expect(sent!.userBlocks, "an empty text block went with it").not.toContain("empty-text");
    expect(sent!.images).toBe(1);
    expect(
      sent!.systems.join("\n"),
      "the image-only turn was sent without its do-not-write instruction"
    ).toContain("carries an image and no text");
  });

  test("the picture is still there on the next turn, when the question arrives", async ({
    page,
    request,
  }) => {
    await pmSettings({ model: "e2e/vision-model" });
    await signIn(page);
    await openChat(page);

    await attach(page);
    await sendButton(page).click();
    await expect(reply(page)).toContainText("Noted.");

    await say(page, "What is wrong with it?", { say: "The pixel is white." });
    await expect(reply(page)).toContainText("The pixel is white.");

    const sent = await lastRequest(request);
    expect(sent).not.toBeNull();
    expect(sent!.userBlocks, "the follow-up itself carries no image").toEqual(["text"]);
    expect(sent!.images, "the screenshot was dropped from history").toBe(1);
    expect(sent!.roles.filter((r) => r === "user")).toHaveLength(2);
    expect(sent!.systems.join("\n")).not.toContain("carries an image and no text");
  });

  test("a refused send hands the picture back instead of destroying it", async ({ page }) => {
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
    await expect(page.getByAltText("Attachment preview")).toBeVisible();
    await expect(agentSpoke(page)).toHaveCount(0);

    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(sendButton(page)).toBeEnabled();

    const [second] = await Promise.all([
      page.waitForRequest((r) => r.method() === "POST" && r.url().includes("/pm/chat")),
      sendButton(page).click(),
    ]);
    expect(JSON.parse(second.postData() ?? "{}").attachments).toEqual(
      JSON.parse(first.postData() ?? "{}").attachments
    );
  });

  test("what was typed comes back with the picture", async ({ page }) => {
    await pmSettings({ model: "e2e/text-only-model" });
    await signIn(page);
    await openChat(page);

    await attach(page);
    await chatBox(page).fill("Look at this one.");
    await sendButton(page).click();

    await expect(page.getByText(/does not accept images/)).toBeVisible();
    await expect(chatBox(page)).toHaveValue("Look at this one.");
    await expect(page.getByAltText("Attachment preview")).toBeVisible();
  });

  test("attaching after a failure takes the stale Retry away with the banner", async ({ page }) => {
    await signIn(page);
    await openChat(page);

    await say(page, "This one will not go through.", { status: 500 });
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

    await page.setInputFiles(
      'input[type="file"]',
      Array.from({ length: 6 }, (_, i) => ({
        name: `after-${i}.png`,
        mimeType: "image/png",
        buffer: PNG,
      }))
    );

    await expect(page.getByText("Attached 4 of 6 — 4 images per message.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  });

  test("a Retry with nothing left to send is not offered", async ({ page }) => {
    await spendTurns(3);
    await pmSettings({ dailyTurnCap: 3, model: "e2e/vision-model" });
    await signIn(page);
    await openChat(page);

    await attach(page);
    await sendButton(page).click();

    const retry = page.getByRole("button", { name: "Retry" });
    await expect(retry).toBeVisible();

    await page.getByRole("button", { name: "Remove attachment" }).click();
    await expect(page.getByAltText("Attachment preview")).toHaveCount(0);
    await expect(retry).toHaveCount(0);
  });

  test("a turn that fails mid-stream offers no Retry when it carried a picture", async ({
    page,
  }) => {
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

    expect(
      await withDb(async (db) => db.collection("pmmessages").countDocuments({ project: PROJECT_ID }))
    ).toBe(0);
  });

  test("an image whose bytes vanish between the check and the turn is not sent as nothing",
    async ({ page, request }) => {
    await pmSettings({ model: "e2e/vision-model" });
    await signIn(page);
    await openChat(page);

    await attach(page);
    await expect(page.getByAltText("Attachment preview")).toBeVisible();

    await withDb(async (db) => {
      await db.collection("uploads.chunks").deleteMany({});
    });

    await sendButton(page).click();

    await expect(reply(page)).toContainText("That image could not be read");
    const sent = await lastRequest(request);
    expect(sent, "an empty turn was sent to the model anyway").toBeNull();
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

    await page.reload();
    await expect(reply(page)).toContainText("Understood, just between us.");

    await other.close();
  });
});
