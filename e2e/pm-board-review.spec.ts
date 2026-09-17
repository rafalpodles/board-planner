import { test, expect, type Page } from "@playwright/test";
import { PM_STUB_URL } from "../playwright.config";
import { PROJECT_KEY, REVIEW_DUPLICATE_TITLES, REVIEW_TASK_NUMBERS, seed, seedBoardForReview } from "./seed";
import { signIn } from "./session";
import { ADMIN_AUTH } from "./api";

/**
 * BP-471. The board review ran only on the scheduler's clock, which the suite parks at 24 hours so
 * a spec that switches the review on cannot spend a turn mid-run. So an owner could switch it on,
 * save, and hear nothing — with no test anywhere that would have noticed. "Run a review now" goes
 * through the same path as the schedule: the caps, the project's turn lock, the digest, and the
 * tools the review is not allowed to use.
 *
 * The model is the OpenRouter stub. It recognises the review's own prompt and asks to move the
 * first task the digest flags, which is exactly what the review may not do.
 */

const SETTINGS = `/projects/${PROJECT_KEY}/settings?section=pm`;

interface StubRequest {
  offeredTools: string[];
  contents: { role: string; text: string }[];
}

async function lastModelRequest(page: Page): Promise<StubRequest> {
  return (await page.request.get(`${PM_STUB_URL}/last`)).json();
}

async function runReviewNow(page: Page) {
  await page.goto(SETTINGS);
  await expect(page.getByRole("heading", { name: "When it acts on its own" })).toBeVisible();
  const started = page.waitForResponse((r) => r.url().endsWith("/pm/review") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Run a review now" }).click();
  return started;
}

/**
 * The turn lock lives in the server's memory and outlives seed(). A test whose review finishes on
 * its own waits for its answer instead; the one that holds a review open stops it here and waits
 * for the lock to go before the next test asks for one of its own.
 */
async function releaseTheTurn(page: Page) {
  await expect
    .poll(async () => (await page.request.post(`/api/projects/${PROJECT_KEY}/pm/interrupt`, { headers: ADMIN_AUTH })).status(), {
      timeout: 30_000,
    })
    .toBe(404);
}

/** The agent's answer as the thread stores it, once there is one with words in it */
async function reviewAnswer(page: Page): Promise<string> {
  let answer = "";
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/projects/${PROJECT_KEY}/pm/messages`, { headers: ADMIN_AUTH });
        const { messages } = (await res.json()) as { messages: { role: string; content: string; trigger?: { type: string } }[] };
        answer = messages.find((m) => m.role === "assistant" && m.trigger?.type === "daily_review" && m.content.trim())?.content ?? "";
        return answer;
      },
      { timeout: 30_000 }
    )
    .not.toBe("");
  return answer;
}

test.beforeEach(async ({ request }) => {
  await seed();
  await seedBoardForReview();
  await request.post(`${PM_STUB_URL}/reset`);
});

test("an owner runs the review now, and its report lands in the chat as a scheduled review", async ({ page }) => {
  await signIn(page);

  expect((await runReviewNow(page)).status()).toBe(202);
  await expect(page.getByText("Review started — its report will appear in the PM chat")).toBeVisible();

  // Waited for as words, not as a message: the turn stores an empty answer before its first call,
  // and that empty message already carries the mark
  expect(await reviewAnswer(page)).toBe("Done.");

  await page.goto(`/projects/${PROJECT_KEY}/pm`);
  // Both halves of the exchange carry the mark: the digest's headline and the agent's answer, each
  // in its own bubble
  const mark = page.getByText("Scheduled review", { exact: true });
  const bubbleWith = (text: string | RegExp) =>
    page.locator("div.rounded-lg").filter({ has: page.getByText(text, { exact: typeof text === "string" }) }).filter({ has: mark });
  await expect(bubbleWith(/Scheduled board review — \d+ open tasks; .*possible duplicate/)).toHaveCount(1);
  await expect(bubbleWith("Done.")).toHaveCount(1);
});

test("the review is built from the board and cannot move, create or assign tasks", async ({ page }) => {
  await signIn(page);
  expect((await runReviewNow(page)).status()).toBe(202);
  await reviewAnswer(page);

  await expect
    .poll(async () => (await lastModelRequest(page))?.contents?.some((m) => m.role === "tool"), { timeout: 30_000 })
    .toBe(true);
  const sent = await lastModelRequest(page);

  // The tools a review is not allowed are not offered at all
  expect(sent.offeredTools).not.toContain("change_status");
  expect(sent.offeredTools).not.toContain("create_task");
  expect(sent.offeredTools).not.toContain("assign_task");
  expect(sent.offeredTools).toContain("get_task");

  // The digest names what it was built to find: the gap, the task stuck in its column, the pair
  const prompt = sent.contents.filter((m) => m.role === "user").map((m) => m.text).join("\n");
  const [stuck, twin] = REVIEW_TASK_NUMBERS.map((n) => `${PROJECT_KEY}-${n}`);
  expect(prompt).toMatch(new RegExp(`- ${stuck} \\[In Progress\\] "${REVIEW_DUPLICATE_TITLES[0]}" — no acceptance criteria and description`));
  expect(prompt).toMatch(new RegExp(`- ${stuck} \\[In Progress\\] "${REVIEW_DUPLICATE_TITLES[0]}" — \\d+ days`));
  expect(prompt).toContain(`${twin} "${REVIEW_DUPLICATE_TITLES[1]}"`);

  // Asked anyway, the move is refused at dispatch, not only left out of the list
  const refusal = sent.contents.find((m) => m.role === "tool")!.text;
  expect(refusal).toContain("change_status is not available in this turn");
});

test("a second review is refused while the first still holds the project's turn", async ({ page }) => {
  await signIn(page);
  // A title the stub answers slowly, so the first review is still running when the second is asked for
  const held = await page.request.post(`/api/projects/${PROJECT_KEY}/tasks`, {
    headers: ADMIN_AUTH,
    data: { title: "Hold this one (hold the review)", status: "todo" },
  });
  expect(held.ok()).toBe(true);

  expect((await runReviewNow(page)).status()).toBe(202);
  const second = await runReviewNow(page);

  expect(second.status()).toBe(409);
  await expect(page.getByText("The review cannot run: a PM turn is already running on this project.")).toBeVisible();

  await releaseTheTurn(page);
});
