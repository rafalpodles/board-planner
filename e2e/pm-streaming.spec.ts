import { test, expect, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { PROJECT_KEY, SIBLING_TASK_ID, SIBLING_TASK_KEY, seed } from "./seed";
import { signIn } from "./session";
import { PM_STUB_URL } from "../playwright.config";

/**
 * BP-1037. The PM's answer reaches the page while the model is still writing it: the stub streams
 * the completion in pieces (`chunkDelayMs`), and the page has to show the growing text, say which
 * tool is being prepared, and survive a stream that is cut.
 */

const PM_URL = `/projects/${PROJECT_KEY}/pm`;

const chatBox = (page: Page) => page.getByPlaceholder(/Message the PM/);
const sendButton = (page: Page) => page.getByRole("button", { name: "Send", exact: true });
const liveText = (page: Page) => page.getByTestId("pm-live-text");
// The message a test types holds the directive, so the answer is read off the agent's own bubble
const reply = (page: Page) => page.getByText("PM Agent", { exact: true }).last().locator("xpath=..");

async function say(page: Page, prompt: string, directive: Record<string, unknown>) {
  await chatBox(page).fill(`${prompt} <<${JSON.stringify(directive)}>>`);
  await sendButton(page).click();
}

test.beforeEach(async ({ request, page }) => {
  await seed();
  await request.post(`${PM_STUB_URL}/reset`);
  await signIn(page);
  await page.goto(PM_URL);
  await expect(chatBox(page)).toBeVisible();
});

test.afterEach(async ({ request }) => {
  await request.post(`/api/projects/${PROJECT_KEY}/pm/interrupt`, { headers: ADMIN_AUTH });
});

test.describe("an answer that is still being written", () => {
  const ANSWER = "The plan has three steps: scope it, build it, and then ship it to everyone.";

  test("is on the page before the turn is over, and the finished message replaces it", async ({ page }) => {
    await say(page, "Plan it.", { say: ANSWER, chunkDelayMs: 400 });

    await expect(liveText(page)).toBeVisible();
    const early = (await liveText(page).textContent()) ?? "";
    expect(early.length, "the page waited for the whole answer").toBeLessThan(ANSWER.length);
    expect(ANSWER.startsWith(early.trim())).toBe(true);
    await expect(page.getByText("PM is writing…")).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop the PM turn" })).toBeVisible();

    await expect(liveText(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(reply(page)).toContainText(ANSWER);
    await expect(sendButton(page)).toBeVisible();
  });

  test("grows between two looks", async ({ page }) => {
    await say(page, "Plan it.", { say: ANSWER, chunkDelayMs: 400 });

    await expect(liveText(page)).toBeVisible();
    const first = (await liveText(page).textContent()) ?? "";
    await expect
      .poll(async () => ((await liveText(page).textContent()) ?? "").length, { timeout: 10_000 })
      .toBeGreaterThan(first.length);
  });
});

test.describe("a tool the agent is about to use", () => {
  test("is named while it is prepared, and its chip appears once it has run", async ({ page, request }) => {
    await say(page, "Leave a note.", {
      name: "add_comment",
      arguments: { taskKey: SIBLING_TASK_KEY, body: "Split this into two smaller tasks." },
      chunkDelayMs: 600,
    });

    await expect(page.getByRole("status").filter({ hasText: "Preparing a comment…" })).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(SIBLING_TASK_KEY) })).toBeVisible({ timeout: 30_000 });
    await expect(reply(page)).toContainText("Done.");

    const comments = await request.get(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}/comments`, { headers: ADMIN_AUTH });
    expect(JSON.stringify(await comments.json()), "the tool this test's cut variant leaves unrun did run here").toContain("Split this into two smaller tasks.");
  });
});

test.describe("a stream the provider cuts off", () => {
  test("ends the turn with an error, keeps the half-written text out of the thread and offers Retry", async ({ page }) => {
    await say(page, "Plan it.", { say: "This answer will never get to its last sentence.", cutAfterChunks: 3 });

    await expect(page.getByText(/The connection to the model was cut off/).first()).toBeVisible({ timeout: 30_000 });
    await expect(reply(page)).toContainText(/⚠️ The connection to the model was cut off/);
    await expect(reply(page)).not.toContainText("This ans");
    await expect(liveText(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("leaves a cut stream that carried a tool call unexecuted", async ({ page, request }) => {
    await say(page, "Leave a note.", {
      name: "add_comment",
      arguments: { taskKey: SIBLING_TASK_KEY, body: "Never to be written." },
      cutAfterChunks: 3,
    });

    await expect(page.getByText(/The connection to the model was cut off/).first()).toBeVisible({ timeout: 30_000 });
    const comments = await request.get(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}/comments`, { headers: ADMIN_AUTH });
    expect(JSON.stringify(await comments.json())).not.toContain("Never to be written.");
  });
});

test.describe("a Stop pressed while the answer is arriving", () => {
  test("ends the turn as stopped and does not keep the half-written text", async ({ page }) => {
    await say(page, "Plan it.", { say: "The plan has three steps: scope it, build it, and then ship it to everyone.", chunkDelayMs: 400 });
    await expect(liveText(page)).toBeVisible();

    await page.getByRole("button", { name: "Stop the PM turn" }).click();

    await expect(page.getByText("⏹ Stopped by user.")).toBeVisible({ timeout: 15_000 });
    await expect(reply(page)).not.toContainText("The plan has");
    await expect(liveText(page)).toHaveCount(0);
    await expect(sendButton(page)).toBeVisible();
  });
});
