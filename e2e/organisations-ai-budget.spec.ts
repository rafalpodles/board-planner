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

const spend = (who: OrganisationFixture, kind: "day" | "month" | "trial", tokens: number) =>
  withDb(async (db) => {
    const period = kind === "day" ? TODAY : kind === "month" ? MONTH : "all";
    await db.collection("aibudgets").deleteMany({ organisation: who.organisation, kind, period });
    await db.collection("aibudgets").insertOne({ organisation: who.organisation, kind, period, tokens, calls: 1, ownTokens: 0, ownCalls: 0 });
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
