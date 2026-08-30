import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-284. `pm.dailyTurnCap` counts turns, and a turn is up to fifteen model round-trips — so a
 * hundred turns is between a hundred and fifteen hundred calls, and the settings screen showed only
 * the number that cannot say which. Driven end to end because the recording spans the provider
 * client, the agent loop and the stored message, and every unit test on the way mocks the next
 * layer down.
 */

test.beforeEach(seed);

test.afterEach(async ({ request }) => {
  await request.post(`/api/projects/${PROJECT_KEY}/pm/interrupt`, { headers: ADMIN_AUTH });
});

const usage = async (request: APIRequestContext) => {
  const res = await request.get(`/api/projects/${PROJECT_ID}/pm/usage`, { headers: ADMIN_AUTH });
  expect(res.status(), await res.text()).toBe(200);
  return res.json() as Promise<{
    turns: { used: number; cap: number };
    calls: number;
    tokens: number;
    tokenCap: number;
    stepLimitHits: number;
    maxCallsPerTurn: number;
  }>;
};

async function say(page: Page, prompt: string, directive: Record<string, unknown>) {
  await page.getByPlaceholder(/Message the PM/).fill(`${prompt} <<${JSON.stringify(directive)}>>`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

test("a turn's real cost is recorded and shown, in calls and tokens", async ({ page, request }) => {
  // The premise: nothing has been spent yet, so the numbers below came from the turn and not from
  // the seed
  expect(await usage(request)).toMatchObject({ calls: 0, tokens: 0, turns: { used: 0 } });

  await signIn(page, "admin");
  await page.goto(`/projects/${PROJECT_KEY}/pm`);
  await expect(page.getByPlaceholder(/Message the PM/)).toBeVisible();

  await test.step("one turn that calls a tool costs more than one model call", async () => {
    await say(page, "make a task", {
      name: "create_task",
      arguments: { title: "Something to do", description: "" },
    });
    await expect
      .poll(async () => (await usage(request)).turns.used, { timeout: 40_000 })
      .toBe(1);

    const spent = await usage(request);
    // The whole point of the ticket: one turn, more than one call
    expect(spent.calls).toBeGreaterThan(1);
    expect(spent.tokens).toBeGreaterThan(0);
    expect(spent.maxCallsPerTurn).toBe(15);
  });

  await test.step("and the settings screen says what a turn can cost, beside what it did", async () => {
    await page.goto(`/projects/${PROJECT_KEY}/settings?section=pm`);

    await expect(page.getByText(/One turn is up to 15 model calls/)).toBeVisible();
    const today = page.getByTestId("pm-usage-today");
    await expect(today).toContainText("1 turns");
    await expect(today).toContainText("model calls");
    await expect(today).toContainText("tokens");
  });
});

/**
 * The control the whole change is shaped around: the ceiling ships off, so nothing that worked
 * yesterday is refused today. A cap that stops the PM working would be worse than a cap that bounds
 * nothing.
 */
test("the token ceiling refuses nothing while it is unset", async ({ page, request }) => {
  expect((await usage(request)).tokenCap).toBe(0);

  await signIn(page, "admin");
  await page.goto(`/projects/${PROJECT_KEY}/pm`);
  await expect(page.getByPlaceholder(/Message the PM/)).toBeVisible();
  await say(page, "say something", {});

  await expect(page.getByText("PM Agent", { exact: true }).first()).toBeVisible({ timeout: 40_000 });
  await expect
    .poll(async () => (await usage(request)).turns.used, { timeout: 40_000 })
    .toBe(1);
});
