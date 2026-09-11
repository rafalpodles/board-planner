import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { ADMIN_AUTH, MEMBER_AUTH } from "./api";
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
    promptTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    tokenCap: number;
    stepLimitHits: number;
    maxCallsPerTurn: number;
  }>;
};

/**
 * The completion requests the provider actually received, in order (BP-568). Read from the stub
 * rather than from the app: the agent hands `chatCompletion` one array and pushes into it as the
 * turn runs, so call 1 and call 2 are the same object in memory and comparing them proves only
 * that an array equals itself.
 */
const sentRequests = async (request: APIRequestContext) => {
  const res = await request.get(`${PM_STUB_URL}/requests`);
  expect(res.status(), await res.text()).toBe(200);
  return res.json() as Promise<
    {
      sessionId: string | null;
      messageCount: number;
      cacheControls: number;
      markedRoles: string[];
      markedPrefix: string | null;
      lastRole: string | null;
    }[]
  >;
};

// Number formatting follows the browser's locale, and the runner's is not something a test may
// assume. What is being asserted is the figure, not its thousands separator.
const figuresIn = async (locator: Locator) => ((await locator.textContent()) ?? "").replace(/\D/g, "");

/** Points the project at a model whose provider caches only what a breakpoint marks. */
const useMarkingModel = async (request: APIRequestContext) => {
  const saved = await request.put(`/api/projects/${PROJECT_ID}`, {
    headers: ADMIN_AUTH,
    data: { pm: { enabled: true, model: "anthropic/e2e-stub-model" } },
  });
  expect(saved.status(), await saved.text()).toBe(200);
};

async function say(page: Page, prompt: string, directive: Record<string, unknown>) {
  await page.getByPlaceholder(/Message the PM/).fill(`${prompt} <<${JSON.stringify(directive)}>>`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

/**
 * Answers the server has actually stored — an assistant chat row with content in it.
 *
 * The signal to sync a second turn on, and not the stub's request count: that rises when the
 * FIRST call of a turn arrives, so a test waiting on it sends the next message while the turn is
 * still running. The per-project lock then refuses that POST, or the empty assistant row is
 * skipped by `replayHistory` and the request under inspection has no history in it at all.
 * `pm-trust-boundary.spec.ts` documents the same trap, reached from the rendered side.
 *
 * Polling `pm/messages` is safe **because of an ordering elsewhere**, which is worth naming since
 * nothing here would survive its being changed: the route calls `finalizeAbandonedTurns` on every
 * GET, and that would write an abandonment notice into a row this helper counts — but it returns
 * immediately while `isTurnRunning`, and the chat route takes that lock BEFORE `runPmTurn` creates
 * the empty assistant row. Move `acquireTurnLock` after the row and this file reddens for a reason
 * that looks unrelated to it.
 *
 * `limit` asks for the most the route will give — it clamps to 100 (`pm/messages/route.ts:14`), so
 * a larger number here would read as a bound it is not. Past 100 messages in one thread this stops
 * rising and the poll times out rather than lying; these threads hold at most six. Only chat turns
 * are counted, because `pmThreadFilter` is thread-wide and an autonomous turn landing mid-test
 * would satisfy the wait without this test's own turn having finished — the same shape as the bug
 * it replaces.
 */
const answered = async (request: APIRequestContext) => {
  const res = await request.get(`/api/projects/${PROJECT_KEY}/pm/messages?limit=100`, {
    headers: ADMIN_AUTH,
  });
  expect(res.status(), await res.text()).toBe(200);
  const { messages } = (await res.json()) as {
    messages: { role: string; content: string; trigger?: { type?: string } }[];
  };
  return messages.filter(
    (m) => m.role === "assistant" && m.content.trim() && (m.trigger?.type ?? "chat") === "chat"
  ).length;
};

/** Sends a message and waits for the server's own answer to it, not for the provider's first call. */
async function sayAndWait(page: Page, request: APIRequestContext, prompt: string, directive: Record<string, unknown>) {
  const before = await answered(request);
  await say(page, prompt, directive);
  await expect.poll(() => answered(request), { timeout: 40_000 }).toBeGreaterThan(before);
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

/**
 * BP-562. The settings screen only offers this inside its `projectAdmin` section — same shape
 * as BP-549 for the audit log — so a member must be refused by the route itself, not just hidden
 * from it on screen.
 */
test("a member is refused — this is spend, not something every board member should read", async ({
  request,
}) => {
  const res = await request.get(`/api/projects/${PROJECT_ID}/pm/usage`, { headers: MEMBER_AUTH });
  expect(res.status()).toBe(403);
});

/**
 * BP-568. A turn is up to fifteen calls and the front of every request is byte-identical across
 * all of them. Whether that prefix is billed once or fifteen times is the provider's decision, and
 * this instance could not see which: `prompt_tokens_details` was dropped before it reached the
 * stored message, so every token on the settings screen read as a cold prompt.
 *
 * Driven end to end because the claim spans the provider client, the agent loop, the schema field,
 * the aggregation path that has to spell that field the same way, the route and the page — and
 * every unit test on the way mocks the next layer down. The aggregation in particular is asserted
 * nowhere else against real Mongo: a renamed field there sums zeros in perfect silence.
 */
test("what a turn read from the cache is recorded, and shown as a share of what it spent", async ({
  page,
  request,
}) => {
  expect(await usage(request)).toMatchObject({ tokens: 0, cachedTokens: 0, cacheWriteTokens: 0 });

  await signIn(page, "admin");
  await page.goto(`/projects/${PROJECT_KEY}/pm`);
  await expect(page.getByPlaceholder(/Message the PM/)).toBeVisible();

  await say(page, "make a task", {
    name: "create_task",
    arguments: { title: "Something to do", description: "" },
  });
  await expect
    .poll(async () => (await usage(request)).calls, { timeout: 40_000 })
    .toBeGreaterThan(1);

  const spent = await usage(request);

  await test.step("the cache figures survive the whole chain to the API", async () => {
    /**
     * Exact, not merely non-zero. The stub answers every call with 1000 prompt + 200 completion
     * tokens and reports the prefix as written on the first call and read back on the second, so
     * a two-call turn has exactly one write and one read of 900. A `> 0` assertion here passed
     * just as happily when the read was being counted twice.
     *
     * The property the ticket turns on is the last line: a cached token was already counted as a
     * prompt token, so 2400 is what the day cost either way. Adding the cached figure in would
     * make a saving read as an overspend on the very screen the budget is set from.
     */
    expect(spent).toMatchObject({
      calls: 2,
      cacheWriteTokens: 900,
      cachedTokens: 900,
      tokens: 2 * 1200,
      // The denominator the share is taken over: prompt tokens only, since a cache read is never
      // part of what the model wrote. 900 of 2000 is 45%; over the day's 2400 it would read 38%
      promptTokens: 2 * 1000,
    });
  });

  await test.step("and the settings screen says what share of the day was cheap", async () => {
    await page.goto(`/projects/${PROJECT_KEY}/settings?section=pm`);

    const cache = page.getByTestId("pm-usage-cache");
    await expect(cache).toContainText("read from the provider's cache");
    // The figure's own element, compared whole: a digit strip of the sentence would also match
    // this number inside a larger one, so rendering ten times the value would still pass
    expect(await figuresIn(page.getByTestId("pm-usage-cached-tokens"))).toBe(String(spent.cachedTokens));
    // The share, and the denominator it is a share of, both on the line the operator reads
    await expect(cache).toContainText("45%");
    await expect(cache).toContainText("prompt tokens");
    // The control: the total it is a share of is still on screen, unchanged by any of this — read
    // off the totals line specifically, which is not the line under test
    expect(await figuresIn(page.getByTestId("pm-usage-totals"))).toContain(String(spent.tokens));
  });

  // The control on the other half of the change: this project's model caches on its own, so its
  // requests must be exactly what they were before any of this shipped
  await test.step("and nothing was marked, because this provider caches on its own", async () => {
    const sent = await sentRequests(request);
    expect(sent.map((r) => r.cacheControls)).toEqual([0, 0]);
    expect(sent.every((r) => r.markedPrefix === null)).toBe(true);
  });
});

/**
 * BP-568, the other half: what goes on the wire. A prefix that differs by one byte between two
 * calls of the same turn is a cache miss whatever the provider does.
 *
 * Asserted on `markedPrefix`, the bytes up to the app's own last breakpoint. An earlier version
 * compared a prefix the stub worked out for itself from the shape of the conversation — which two
 * calls of one turn agree on however the app behaves, so it could not fail. It needs a marking
 * model for the same reason: with no breakpoints there is no claim on the wire to compare.
 *
 * The equality is unconditional. Nothing about the thread's length or age changes where the mark
 * goes, which is deliberate and is the thing most likely to be undone by someone reasoning that a
 * short turn should not pay for a write — `agent.test.ts` carries that argument and why it is
 * wrong.
 */
test("the calls of one turn mark the same prefix, and name one session", async ({ page, request }) => {
  await useMarkingModel(request);

  await signIn(page, "admin");
  await page.goto(`/projects/${PROJECT_KEY}/pm`);
  await expect(page.getByPlaceholder(/Message the PM/)).toBeVisible();

  // One conversational turn first, so the prefix under comparison is a replayed history and not
  // the system prompt on its own
  await sayAndWait(page, request, "an older question", {});
  await request.post(`${PM_STUB_URL}/reset`);

  await say(page, "make a task", {
    name: "create_task",
    arguments: { title: "Another thing", description: "" },
  });
  await expect.poll(async () => (await sentRequests(request)).length, { timeout: 40_000 }).toBe(2);

  const [first, second] = await sentRequests(request);

  expect(first.markedPrefix).not.toBeNull();
  expect(second.markedPrefix).toBe(first.markedPrefix);
  // The control: the second request really had grown past that prefix, so the two were not equal
  // for the trivial reason that nothing was added
  expect(second.messageCount).toBeGreaterThan(first.messageCount);

  // One conversation, so OpenRouter's sticky routing sends the second call to the endpoint the
  // first one warmed rather than to a cold one
  expect(first.sessionId).toMatch(/^[0-9a-f]{32}$/);
  expect(second.sessionId).toBe(first.sessionId);
});

/**
 * The same turn against a model that caches only what is marked. Nothing about the stub changes —
 * only the model id the project names — so this is the family check itself, seen from the wire.
 *
 * Two turns, because the boundary is only visible once there is a history to end. A cache write
 * costs more than the cold prompt it replaces, so the mark has to land where a later request
 * reads it back: on the replayed history, which every following turn still begins with — and NOT
 * on this turn's own question, which the next turn has already grown past (BP-568 review).
 */
test("the breakpoints go to a provider that needs them, and stop at the replayed history", async ({
  page,
  request,
}) => {
  await useMarkingModel(request);

  await signIn(page, "admin");
  await page.goto(`/projects/${PROJECT_KEY}/pm`);
  await expect(page.getByPlaceholder(/Message the PM/)).toBeVisible();

  await sayAndWait(page, request, "the first question", {});
  await sayAndWait(page, request, "the second question", {});

  const [first, second] = await sentRequests(request);
  // Two conversational turns, one call each — if either had run long the pair below would be
  // comparing the wrong two requests
  expect(await sentRequests(request)).toHaveLength(2);

  // Nothing to replay yet, so the system prompt is the whole of what outlives the turn
  expect(first.markedRoles).toEqual(["system"]);

  /**
   * Now there is a history, and the second mark sits on its last message — the previous turn's
   * answer. If it followed the end of the request instead it would land on the user message this
   * turn just added, and `lastRole` below is what says those two are not the same place.
   */
  expect(second.markedRoles).toEqual(["system", "assistant"]);
  expect(second.lastRole).toBe("user");
});
