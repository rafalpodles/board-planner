import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";
import { PM_STUB_URL } from "../playwright.config";

/**
 * BP-284. `pm.dailyTurnCap` counts turns, and a turn is up to fifteen model round-trips — so a
 * hundred turns is between a hundred and fifteen hundred calls, and the settings screen showed only
 * the number that cannot say which. Driven end to end because the recording spans the provider
 * client, the agent loop and the stored message, and every unit test on the way mocks the next
 * layer down.
 */

test.beforeEach(seed);

/**
 * The stub is one process for the whole run and carries per-directive state (its `failTimes`
 * counter, its escalation path), so a neighbouring spec can leave it answering in prose where this
 * one needs a tool call — and then "one turn, more than one call" is false for a reason that has
 * nothing to do with the code. A turn another file left running would refuse this one with a 409
 * as well. Both ends reset: this spec passed alone and failed after the group.
 */
test.beforeEach(async ({ request }) => {
  await request.post(`${PM_STUB_URL}/reset`);
  await request.post(`/api/projects/${PROJECT_KEY}/pm/interrupt`, { headers: ADMIN_AUTH });
});

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
    /**
     * Waits for the turn to have RUN, not for it to have been asked. `turns.used` counts stored
     * user messages, so it reaches 1 the moment the request is accepted — before a single call has
     * been made. This spec passed alone and failed after a loaded group on exactly that: `calls`
     * read 0 while `turns.used` read 1.
     *
     * The wait and the assertion are different propositions on purpose: "at least one call was
     * made" is what says the turn ran, and "more than one" is the claim this ticket is about, so a
     * turn that really did cost one call still fails below.
     */
    await expect
      .poll(async () => (await usage(request)).calls, { timeout: 40_000 })
      .toBeGreaterThan(0);

    const spent = await usage(request);
    expect(spent.turns.used).toBe(1);
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

  // Same reasoning as above: the call count is what says the turn ran
  await expect
    .poll(async () => (await usage(request)).calls, { timeout: 40_000 })
    .toBeGreaterThan(0);
  expect((await usage(request)).turns.used).toBe(1);
});

/**
 * The ceiling, driven the whole way: set through the product, then met.
 *
 * This is also the test whose absence let a dead input ship. The first cut dropped
 * `dailyTokenCap` in `validatePmConfig`'s whitelist rebuild, so the settings screen reported
 * success and wrote nothing — and this spec fails at the **save**, one step before the refusal it
 * is nominally about.
 */
test("a ceiling set through the product is stored, and then refuses a turn", async ({
  page,
  request,
}) => {
  await test.step("it is actually stored", async () => {
    const saved = await request.put(`/api/projects/${PROJECT_ID}`, {
      headers: ADMIN_AUTH,
      data: { pm: { enabled: true, model: "e2e/stub-model", dailyTokenCap: 1 } },
    });
    expect(saved.status(), await saved.text()).toBe(200);

    // Read back, not assumed: a 200 says the request was accepted, never that the field survived
    expect((await usage(request)).tokenCap).toBe(1);
  });

  await test.step("a turn spends past it", async () => {
    await signIn(page, "admin");
    await page.goto(`/projects/${PROJECT_KEY}/pm`);
    await expect(page.getByPlaceholder(/Message the PM/)).toBeVisible();
    await say(page, "say something", {});
    await expect
      .poll(async () => (await usage(request)).tokens, { timeout: 40_000 })
      .toBeGreaterThan(1);
  });

  await test.step("and the next one is refused, saying what it cost and why the turn cap did not stop it", async () => {
    const refused = await request.post(`/api/projects/${PROJECT_KEY}/pm/chat`, {
      headers: ADMIN_AUTH,
      data: { message: "again" },
    });

    expect(refused.status()).toBe(429);
    const { error } = await refused.json();
    expect(error).toMatch(/token cap/i);
    expect(error).toMatch(/model calls/);
    // The sentence the ticket is about
    expect(error).toMatch(/up to 15 calls/);
  });
});
