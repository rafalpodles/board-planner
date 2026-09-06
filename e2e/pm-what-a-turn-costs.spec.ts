import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_AUTH, MEMBER_AUTH } from "./api";
import { PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";
import { PM_STUB_URL } from "../playwright.config";

test.beforeEach(seed);

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
      .poll(async () => (await usage(request)).calls, { timeout: 40_000 })
      .toBeGreaterThan(0);

    const spent = await usage(request);
    expect(spent.turns.used).toBe(1);
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

test("the token ceiling refuses nothing while it is unset", async ({ page, request }) => {
  expect((await usage(request)).tokenCap).toBe(0);

  await signIn(page, "admin");
  await page.goto(`/projects/${PROJECT_KEY}/pm`);
  await expect(page.getByPlaceholder(/Message the PM/)).toBeVisible();
  await say(page, "say something", {});

  await expect
    .poll(async () => (await usage(request)).calls, { timeout: 40_000 })
    .toBeGreaterThan(0);
  expect((await usage(request)).turns.used).toBe(1);
});

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
    expect(error).toMatch(/up to 15 calls/);
  });
});

test("a member is refused — this is spend, not something every board member should read", async ({
  request,
}) => {
  const res = await request.get(`/api/projects/${PROJECT_ID}/pm/usage`, { headers: MEMBER_AUTH });
  expect(res.status()).toBe(403);
});
