import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { PM_STUB_URL, RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { signPlatformRequest } from "../src/lib/platform-request";
import { encryptSecret } from "../src/lib/encryption";
import { E2E_PLATFORM_REQUEST_KEY, e2eLicence } from "./licence-key";
import { E2E_ENCRYPTION_KEY, E2E_MONGODB_URI } from "./seed";
import { ACME, GLOBEX, ORGANISATIONS_API, PLATFORM_HOST, SHARED_KEY, originOf, seedTwoOrganisations, signInOn, type OrganisationFixture } from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

/**
 * BP-679, BP-680. What an organisation may spend of the operator's key is counted in tokens, per organisation: Pro gets 15M
 * tokens a month and a daily ceiling of a fifth of that. An organisation that has spent it is refused with the number and
 * the date it renews, and the other organisation, on the same server and the same key, is not touched. Both are Pro here.
 */

const OWN_KEY = "sk-or-acme-own-e2e-0123456789";
const now = new Date();
const TODAY = now.toISOString().slice(0, 10);
const MONTH = now.toISOString().slice(0, 7);

async function makePro(request: APIRequestContext, who: OrganisationFixture, trial = false) {
  const path = `/api/platform/organisations/${who.organisation.toHexString()}/licence`;
  const body = Buffer.from(JSON.stringify({ licenceKey: e2eLicence({ customer: `${who.slug} customer`, organisation: who.organisation.toHexString(), ...(trial ? { trial: true as const } : {}) }) }));
  const headers = signPlatformRequest({ method: "POST", host: PLATFORM_HOST, path, body }, E2E_PLATFORM_REQUEST_KEY);
  const response = await request.post(`${ORGANISATIONS_API}${path}`, { headers: { host: PLATFORM_HOST, "content-type": "application/json", ...headers }, data: body });
  expect(response.status(), await response.text()).toBe(200);
}

/** A request the operator signs: the platform host, and nothing an organisation's own credentials can make */
async function platform(request: APIRequestContext, method: "GET" | "POST", path: string, data?: unknown) {
  const body = data === undefined ? new Uint8Array() : Buffer.from(JSON.stringify(data));
  return request.fetch(`${ORGANISATIONS_API}${path}`, {
    method,
    headers: { host: PLATFORM_HOST, ...(data === undefined ? {} : { "content-type": "application/json" }), ...signPlatformRequest({ method, host: PLATFORM_HOST, path, body }, E2E_PLATFORM_REQUEST_KEY) },
    ...(data === undefined ? {} : { data: body }),
  });
}

const aiLockPath = (who: OrganisationFixture) => `/api/platform/organisations/${who.organisation.toHexString()}/ai`;

async function withDb<T>(run: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await run(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

/** What the organisation may spend a month: 15M, and 1M more for each person above the ten Pro includes */
async function monthlyLimit(who: OrganisationFixture): Promise<number> {
  const people = await withDb((db) => db.collection("users").countDocuments({ organisation: who.organisation, kind: { $ne: "machine" }, deactivatedAt: null }));
  return 15_000_000 + 1_000_000 * Math.max(0, people - 10);
}

const spend = (who: OrganisationFixture, kind: "day" | "month" | "trial", tokens: number, ownTokens = 0, calls = 1, ownCalls = ownTokens ? 1 : 0) =>
  withDb(async (db) => {
    const period = kind === "day" ? TODAY : kind === "month" ? MONTH : "all";
    await db.collection("aibudgets").deleteMany({ organisation: who.organisation, kind, period });
    await db.collection("aibudgets").insertOne({ organisation: who.organisation, kind, period, tokens, calls, ownTokens, ownCalls });
  });

const counters = (who: OrganisationFixture) => withDb((db) => db.collection("aibudgets").find({ organisation: who.organisation }).sort({ kind: 1 }).toArray());
const rows = (who: OrganisationFixture) => withDb((db) => db.collection("aiusages").find({ organisation: who.organisation }).toArray());

/** From inside the page, so the browser's own headers are on the request */
const post = (page: Page, path: string, body: unknown) =>
  page.evaluate(
    async ({ path, body }) => {
      const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { path, body }
  );

const SCRIPTED = `a task <<${JSON.stringify({ title: "From the stub", description: "d", category: "bug", acceptanceCriteria: "" })}>>`;
const chat = (page: Page) => post(page, `/api/projects/${SHARED_KEY}/pm/chat`, { message: `hello <<${JSON.stringify({ say: "Done." })}>>` });
const generate = (page: Page) => post(page, `/api/projects/${SHARED_KEY}/ai/generate-task`, { prompt: SCRIPTED });

async function open(page: Page, who: OrganisationFixture) {
  await signInOn(page.context(), who);
  await page.goto(`${originOf(who)}/projects/${SHARED_KEY}`);
}

test.beforeEach(async ({ request }) => {
  await seedTwoOrganisations();
  await makePro(request, ACME);
  await makePro(request, GLOBEX);
  await request.post(`${PM_STUB_URL}/reset`);
});

test.afterEach(async ({ request }) => {
  await withDb((db) => db.collection("settings").deleteMany({ organisation: { $in: [ACME.organisation, GLOBEX.organisation] } }));
  for (const who of [ACME, GLOBEX]) {
    await request.post(`${ORGANISATIONS_API}/api/projects/${SHARED_KEY}/pm/interrupt`, { headers: { host: new URL(originOf(who)).host, authorization: `Bearer ${who.apiToken}` } });
  }
});

test("an organisation that has spent its month is refused with the number and the day it renews, and the other is not touched", async ({ page }) => {
  const limit = await monthlyLimit(ACME);
  await spend(ACME, "month", limit);

  await open(page, ACME);
  const refusedChat = await chat(page);
  const refusedGeneration = await generate(page);

  for (const refused of [refusedChat, refusedGeneration]) {
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ reason: "ai_budget", scope: "month", used: limit, limit });
    expect(refused.body.error).toMatch(/AI tokens, its allowance for the month\. It renews on 1 .* \(UTC\)/);
  }
  expect((await (await fetch(`${PM_STUB_URL}/last-authorization`)).json()).authorization).toBeNull();
  expect((await (await fetch(`${PM_STUB_URL}/last-assist-authorization`)).json()).authorization).toBeNull();

  await open(page, GLOBEX);
  expect((await chat(page)).status).toBe(200);
  expect((await generate(page)).status).toBe(200);
});

test("a trial has 3M tokens for the whole trial, counted under the trial and not the month, and is refused at them", async ({ page, request }) => {
  await makePro(request, ACME, true);
  await open(page, ACME);
  expect((await chat(page)).status).toBe(200);
  const [dayRow, trialRow] = await counters(ACME);
  expect(dayRow).toMatchObject({ kind: "day", tokens: 1200 });
  expect(trialRow).toMatchObject({ kind: "trial", period: "all", tokens: 1200 });

  await spend(ACME, "trial", 3_000_000);
  const refused = await chat(page);

  expect(refused.status).toBe(429);
  expect(refused.body).toMatchObject({ scope: "trial", used: 3_000_000, limit: 3_000_000, resetsAt: null });
  expect(refused.body.error).toMatch(/the allowance of its trial/);
  expect(refused.body.error).not.toMatch(/renews/);
});

test("the daily ceiling, a fifth of the month, refuses before the month does and starts again at midnight UTC", async ({ page }) => {
  const ceiling = Math.ceil((await monthlyLimit(ACME)) / 5);
  await spend(ACME, "month", 4_000_000);
  await spend(ACME, "day", ceiling);

  await open(page, ACME);
  const refused = await chat(page);

  expect(refused.status).toBe(429);
  expect(refused.body).toMatchObject({ scope: "day", used: ceiling, limit: ceiling });
  expect(refused.body.error).toMatch(/paused for today.*00:00 UTC/);
  expect(new Date(refused.body.resetsAt).getTime()).toBeGreaterThan(Date.now());
  expect(new Date(refused.body.resetsAt).getUTCHours()).toBe(0);
});

test("each call is counted by the tokens the provider reports, for the organisation that made it and nobody else", async ({ page }) => {
  await open(page, GLOBEX);
  expect((await chat(page)).status).toBe(200);
  expect((await generate(page)).status).toBe(200);

  const used = await rows(GLOBEX);
  expect(used).toHaveLength(2);
  expect(used.find((row) => row.source === "pm")).toMatchObject({ keySource: "managed", totalTokens: 1200, project: expect.anything() });
  const assist = used.find((row) => row.source === "assist")!;
  expect(assist).toMatchObject({ keySource: "managed" });
  expect(assist.totalTokens).toBeGreaterThan(0);
  expect(assist.totalTokens).toBe(assist.promptTokens + assist.completionTokens);

  const [day, month] = await counters(GLOBEX);
  expect(day).toMatchObject({ kind: "day", period: TODAY, calls: 2, tokens: 1200 + assist.totalTokens });
  expect(month).toMatchObject({ kind: "month", period: MONTH, calls: 2, tokens: 1200 + assist.totalTokens });
  expect(await rows(ACME)).toEqual([]);
  expect(await counters(ACME)).toEqual([]);
});

test("an organisation's own key is never refused however much it has spent of ours, and is counted apart", async ({ page }) => {
  process.env.ENCRYPTION_KEY = E2E_ENCRYPTION_KEY;
  await withDb(async (db) => {
    await db.collection("settings").deleteMany({ organisation: ACME.organisation });
    await db.collection("settings").insertOne({
      organisation: ACME.organisation,
      aiModel: "gpt-4o-mini",
      signUpDomains: [],
      openrouterKey: encryptSecret(OWN_KEY, ACME.organisation),
      openrouterKeyHint: "6789",
    });
  });
  const limit = await monthlyLimit(ACME);
  await spend(ACME, "month", limit);
  await spend(ACME, "day", Math.ceil(limit / 5));

  await open(page, ACME);
  expect((await chat(page)).status).toBe(200);

  expect((await (await fetch(`${PM_STUB_URL}/last-authorization`)).json()).authorization).toBe(`Bearer ${OWN_KEY}`);
  expect(await rows(ACME)).toEqual([expect.objectContaining({ keySource: "own", totalTokens: 1200 })]);
  const [day, month] = await counters(ACME);
  expect(day).toMatchObject({ tokens: Math.ceil(limit / 5), ownTokens: 1200, ownCalls: 1 });
  expect(month).toMatchObject({ tokens: limit, ownTokens: 1200, ownCalls: 1 });
});

test("on screen: AI Assist and the PM chat say how much was used and when it renews, where an outage would say nothing", async ({ page }) => {
  const limit = await monthlyLimit(ACME);
  await spend(ACME, "month", limit);
  await signInOn(page.context(), ACME);

  await page.goto(`${originOf(ACME)}/projects/${SHARED_KEY}`);
  await page.getByRole("button", { name: "New task" }).click();
  const modal = page.getByRole("dialog", { name: "New Task" });
  await modal.getByPlaceholder("Describe what you need").fill(SCRIPTED);
  await modal.getByRole("button", { name: "Generate" }).click();
  const refusal = new RegExp(`AI is unavailable: this organisation has used ${limit.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} AI tokens, its allowance for the month\\. It renews on 1 `);
  await expect(page.getByText(refusal)).toBeVisible();
  await page.waitForTimeout(700);
  await page.screenshot({ path: "e2e/.artifacts/bp680-assist-refused.png" });
  await page.keyboard.press("Escape");

  await page.goto(`${originOf(ACME)}/projects/${SHARED_KEY}/pm`);
  await page.getByPlaceholder(/Message the PM/).fill("hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(new RegExp(`AI is unavailable: this organisation has used ${limit.toLocaleString("en-US")} of`))).toBeVisible();
  await page.screenshot({ path: "e2e/.artifacts/bp680-chat-refused.png" });

  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${originOf(ACME)}/projects/${SHARED_KEY}/pm`);
  await page.getByPlaceholder(/Message the PM/).fill("hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/its allowance for the month\. It renews on 1 November 2026 \(UTC\)/)).toBeVisible();
  await page.screenshot({ path: "e2e/.artifacts/bp680-chat-refused-phone.png" });
});

// BP-680: the operator's lock is about the operator's key: one organisation's, never the neighbour's, never an own key
test("the operator switches its key off for one organisation: that one is refused, the neighbour and an own key are not, and switching on restores it", async ({ page, request }) => {
  await open(page, ACME);

  const locked = await platform(request, "POST", aiLockPath(ACME), { locked: true, reason: "abuse report 17" });
  expect(locked.status(), await locked.text()).toBe(200);
  expect(await locked.json()).toEqual({ locked: true });

  const refused = await chat(page);
  expect(refused.status).toBe(403);
  expect(refused.body).toMatchObject({ reason: "ai_locked" });
  expect(refused.body.error).toMatch(/AI is switched off for this organisation by the operator: abuse report 17\. Add your own key in Settings → AI key/);
  const generation = await generate(page);
  expect(generation.status).toBe(403);
  expect(generation.body).toMatchObject({ reason: "ai_locked" });
  expect(await rows(ACME)).toEqual([]);

  // The screens do not offer what would be refused
  await page.goto(`${originOf(ACME)}/projects/${SHARED_KEY}`);
  await page.getByRole("button", { name: "New task" }).click();
  const modal = page.getByRole("dialog", { name: "New Task" });
  await expect(modal.getByTestId("ai-locked")).toContainText("AI Assist is switched off for this organisation by the operator.");
  await expect(modal.getByPlaceholder("Describe what you need")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto(`${originOf(ACME)}/projects/${SHARED_KEY}/pm`);
  await expect(page.getByTestId("ai-locked")).toContainText("The PM agent is switched off for this organisation by the operator.");
  await expect(page.getByPlaceholder(/Message the PM/)).toHaveCount(0);

  await open(page, GLOBEX);
  expect((await chat(page)).status).toBe(200);
  expect(await rows(GLOBEX)).toHaveLength(1);

  process.env.ENCRYPTION_KEY = E2E_ENCRYPTION_KEY;
  await withDb(async (db) => {
    await db.collection("settings").deleteMany({ organisation: ACME.organisation });
    await db.collection("settings").insertOne({ organisation: ACME.organisation, aiModel: "gpt-4o-mini", signUpDomains: [], openrouterKey: encryptSecret(OWN_KEY, ACME.organisation), openrouterKeyHint: "6789" });
  });
  await open(page, ACME);
  expect((await chat(page)).status).toBe(200);
  expect(await rows(ACME)).toEqual([expect.objectContaining({ keySource: "own" })]);

  await withDb((db) => db.collection("settings").deleteMany({ organisation: ACME.organisation }));
  expect((await chat(page)).status).toBe(403);
  const unlocked = await platform(request, "POST", aiLockPath(ACME), { locked: false, reason: "sent with an unlock" });
  expect(await unlocked.json()).toEqual({ locked: false });
  // The turn on the own key may still hold the project's one turn for a moment
  let again = await chat(page);
  for (let tries = 0; again.status === 409 && tries < 20; tries++) {
    await page.waitForTimeout(250);
    again = await chat(page);
  }
  expect(again.status).toBe(200);

  // And the screens offer it again
  await page.goto(`${originOf(ACME)}/projects/${SHARED_KEY}`);
  await page.getByRole("button", { name: "New task" }).click();
  const back = page.getByRole("dialog", { name: "New Task" });
  await expect(back.getByPlaceholder("Describe what you need")).toBeVisible();
  await expect(back.getByTestId("ai-locked")).toHaveCount(0);

  const audit = await withDb((db) => db.collection("platformauditlogs").find({ subject: ACME.organisation, action: /^organisation_ai_/ }).sort({ createdAt: 1 }).toArray());
  expect(audit.map((row) => [row.action, row.detail])).toEqual([["organisation_ai_locked", "abuse report 17"], ["organisation_ai_unlocked", ""]]);
});

test("the lock takes only what an operator may send: a true or false, a short reason, an organisation that exists", async ({ request }) => {
  for (const [body, status] of [
    [{ locked: "yes" }, 400],
    [{}, 400],
    [{ locked: true, reason: "x".repeat(501) }, 400],
    [{ locked: true, reason: 5 }, 400],
    [{ locked: true, reason: "x".repeat(500) }, 200],
  ] as const) {
    expect((await platform(request, "POST", aiLockPath(ACME), body)).status(), JSON.stringify(body)).toBe(status);
  }
  expect((await platform(request, "POST", "/api/platform/organisations/0123456789abcdef01234567/ai", { locked: true })).status()).toBe(404);
  expect((await platform(request, "POST", "/api/platform/organisations/000000000000000000000001/ai", { locked: true })).status()).toBe(409);
  const broken = await request.fetch(`${ORGANISATIONS_API}${aiLockPath(ACME)}`, {
    method: "POST",
    headers: { host: PLATFORM_HOST, "content-type": "application/json", ...signPlatformRequest({ method: "POST", host: PLATFORM_HOST, path: aiLockPath(ACME), body: Buffer.from("{not json") }, E2E_PLATFORM_REQUEST_KEY) },
    data: Buffer.from("{not json"),
  });
  expect(broken.status()).toBe(400);
  expect((await platform(request, "POST", "/api/platform/organisations/not-an-id/ai", { locked: true })).status()).toBe(404);

  // The one that was accepted is the one that is on, with its reason; the refused ones changed nothing
  const stored = await withDb((db) => db.collection("organisations").findOne({ _id: ACME.organisation }, { projection: { aiLockedAt: 1, aiLockedReason: 1 } }));
  expect(stored?.aiLockedAt).toBeInstanceOf(Date);
  expect(stored?.aiLockedReason).toBe("x".repeat(500));
});

test("a hosted Free organisation is shown no allowance it does not have, on its own screen or in the operator's list", async ({ page, request }) => {
  await withDb((db) => db.collection("organisations").updateOne({ _id: ACME.organisation }, { $unset: { licenceKey: "" } }));
  await signInOn(page.context(), ACME);

  await page.goto(`${originOf(ACME)}/settings/ai-keys`);
  await expect(page.getByText(/Without a key of your own it does not run on the Free plan/)).toBeVisible();
  await expect(page.getByText("AI usage", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("progressbar")).toHaveCount(0);

  const list = await (await platform(request, "GET", "/api/platform/organisations")).json();
  expect(list.organisations.find((o: { id: string }) => o.id === ACME.organisation.toHexString())).toMatchObject({ plan: "free", ai: { included: false, limit: null, dailyCeiling: null } });
});

test("the operator's list says how much of its allowance each organisation has used and whether its key is switched off", async ({ request }) => {
  const limit = await monthlyLimit(ACME);
  await spend(ACME, "month", 4_200_000, 77_000);
  await spend(ACME, "day", 900_000);
  await platform(request, "POST", aiLockPath(GLOBEX), { locked: true, reason: "unpaid" });

  const list = await (await platform(request, "GET", "/api/platform/organisations")).json();
  const ai = (who: OrganisationFixture) => list.organisations.find((o: { id: string }) => o.id === who.organisation.toHexString()).ai;

  expect(ai(ACME)).toMatchObject({ scope: "month", used: 4_200_000, limit, today: 900_000, dailyCeiling: Math.ceil(limit / 5), ownTokens: 77_000, locked: false });
  expect(ai(ACME).resetsAt).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
  expect(ai(GLOBEX)).toMatchObject({ used: 0, locked: true });
});

test("on screen: Settings → AI key says what has been used and when it renews, and that the operator switched the key off", async ({ page, request }) => {
  const limit = await monthlyLimit(ACME);
  await spend(ACME, "month", 4_200_000, 77_000, 1_340, 41);
  await spend(ACME, "day", 900_000);
  // Three turns this month and two before it, in the organisation's own project; a neighbour's turn that must not count
  const turn = (who: OrganisationFixture, createdAt: Date) => ({ organisation: who.organisation, project: who.projectId, role: "user", content: "hello", actions: [], attachments: [], trigger: { type: "chat", taskKey: "" }, createdAt });
  // The first of the month counts and the last millisecond before it does not, on any day of the month; an answer is not a turn
  const today = new Date();
  const firstOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const beforeIt = new Date(firstOfMonth.getTime() - 1);
  await withDb((db) =>
    db.collection("pmmessages").insertMany([
      turn(ACME, new Date()),
      turn(ACME, firstOfMonth),
      turn(ACME, new Date()),
      turn(ACME, beforeIt),
      turn(ACME, new Date(today.getTime() - 40 * 24 * 60 * 60 * 1000)),
      { ...turn(ACME, new Date()), role: "assistant" },
      turn(GLOBEX, new Date()),
    ])
  );
  await signInOn(page.context(), ACME);

  await page.goto(`${originOf(ACME)}/settings/ai-keys`);
  const month = page.getByTestId("ai-usage-month");
  await expect(page.getByTestId("ai-usage-activity")).toHaveText("3 PM turns this month, and 1,340 model calls on this service's key.");
  await expect(month).toContainText(`4,200,000 of ${limit.toLocaleString("en-US")} tokens used this month. It renews on 1 `);
  await expect(page.getByText(`${Math.floor((4_200_000 / limit) * 100)}% used`)).toBeVisible();
  await expect(page.getByTestId("ai-usage-today")).toContainText(`Today (UTC): 900,000 tokens; one day may use at most ${Math.ceil(limit / 5).toLocaleString("en-US")}.`);
  await expect(page.getByTestId("ai-usage-own")).toContainText("Your own key: 77,000 tokens in 41 calls this month, counted and never limited.");
  await expect(page.getByTestId("ai-usage-locked")).toHaveCount(0);
  await page.screenshot({ path: "e2e/.artifacts/bp680-ai-usage.png" });

  await platform(request, "POST", aiLockPath(ACME), { locked: true, reason: "abuse report 17" });
  await page.reload();
  await expect(page.getByTestId("ai-usage-locked")).toContainText("The operator has switched off the use of its key for this organisation. Add your own key below to keep going.");
  await expect(page.getByText("Switched off", { exact: true })).toHaveCount(2);
  await page.screenshot({ path: "e2e/.artifacts/bp680-ai-usage-locked.png" });

  await page.setViewportSize({ width: 390, height: 800 });
  await page.reload();
  await expect(page.getByTestId("ai-usage-month")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "nothing runs off the screen on a phone").toBe(true);
  await page.screenshot({ path: "e2e/.artifacts/bp680-ai-usage-phone.png" });
});
