import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { PM_STUB_URL, RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { signPlatformRequest } from "../src/lib/platform-request";
import { E2E_PLATFORM_REQUEST_KEY, e2eLicence } from "./licence-key";
import { E2E_MONGODB_URI } from "./seed";
import { ACME, GLOBEX, ORGANISATIONS_API, PLATFORM_HOST, SHARED_KEY, asOrganisation, bearer, oauthBearer, originOf, seedTwoOrganisations, signInOn, type OrganisationFixture } from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

/**
 * BP-678. The platform operator sets what one organisation may spend of the operator's key, in place of its plan's figure,
 * through a signed request, and reads what each one has spent against it. Nobody inside an organisation can.
 */

const MONTH = new Date().toISOString().slice(0, 7);
const EMPTY = new Uint8Array();

async function makePro(request: APIRequestContext, who: OrganisationFixture, trial = false) {
  const path = `/api/platform/organisations/${who.organisation.toHexString()}/licence`;
  const body = Buffer.from(JSON.stringify({ licenceKey: e2eLicence({ customer: `${who.slug} customer`, organisation: who.organisation.toHexString(), ...(trial ? { trial: true as const } : {}) }) }));
  const headers = signPlatformRequest({ method: "POST", host: PLATFORM_HOST, path, body }, E2E_PLATFORM_REQUEST_KEY);
  expect((await request.post(`${ORGANISATIONS_API}${path}`, { headers: { host: PLATFORM_HOST, "content-type": "application/json", ...headers }, data: body })).status()).toBe(200);
}

function putAllowance(request: APIRequestContext, who: OrganisationFixture, body: unknown) {
  const path = `/api/platform/organisations/${who.organisation.toHexString()}/ai-allowance`;
  const data = Buffer.from(JSON.stringify(body));
  const headers = signPlatformRequest({ method: "PUT", host: PLATFORM_HOST, path, body: data }, E2E_PLATFORM_REQUEST_KEY);
  return request.put(`${ORGANISATIONS_API}${path}`, { headers: { host: PLATFORM_HOST, "content-type": "application/json", ...headers }, data });
}

async function listed(request: APIRequestContext) {
  const path = "/api/platform/organisations";
  const response = await request.get(`${ORGANISATIONS_API}${path}`, { headers: { host: PLATFORM_HOST, ...signPlatformRequest({ method: "GET", host: PLATFORM_HOST, path, body: EMPTY }, E2E_PLATFORM_REQUEST_KEY) } });
  expect(response.status()).toBe(200);
  const { organisations } = await response.json();
  return Object.fromEntries(organisations.map((row: { slug: string }) => [row.slug, row])) as Record<string, { ai: Record<string, unknown> | null }>;
}

async function withDb<T>(run: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await run(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

const spendMonth = (who: OrganisationFixture, tokens: number) =>
  withDb(async (db) => {
    await db.collection("aibudgets").deleteMany({ organisation: who.organisation });
    await db.collection("aibudgets").insertOne({ organisation: who.organisation, kind: "month", period: MONTH, tokens, calls: 1, ownTokens: 0, ownCalls: 0 });
  });

const monthlyLimit = async (who: OrganisationFixture) => {
  const people = await withDb((db) => db.collection("users").countDocuments({ organisation: who.organisation, kind: { $ne: "machine" }, deactivatedAt: null }));
  return 15_000_000 + 1_000_000 * Math.max(0, people - 10);
};

const post = (page: Page, path: string, body: unknown) =>
  page.evaluate(
    async ({ path, body }) => {
      const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { path, body }
  );
const chat = (page: Page) => post(page, `/api/projects/${SHARED_KEY}/pm/chat`, { message: `hello <<${JSON.stringify({ say: "Done." })}>>` });

async function open(page: Page, who: OrganisationFixture) {
  await signInOn(page.context(), who);
  await page.goto(`${originOf(who)}/projects/${SHARED_KEY}`);
}

const auditRows = () => withDb((db) => db.collection("platformauditlogs").find({ action: /^ai_allowance/ }).sort({ _id: 1 }).toArray());

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

test.describe("an organisation's AI allowance, set by the operator", () => {
  test("replaces the plan's figure for that organisation only, is lifted by unlimited and undone by null", async ({ page, request }) => {
    await spendMonth(ACME, 1_000);
    await spendMonth(GLOBEX, 1_000);

    const set = await putAllowance(request, ACME, { tokens: 1_000, reason: "abuse, invoice 42" });
    expect(set.status(), await set.text()).toBe(200);
    expect(await set.json()).toEqual({ aiAllowance: { tokens: 1_000, scope: "month" } });

    await open(page, ACME);
    const refused = await chat(page);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ reason: "ai_budget", scope: "month", used: 1_000, limit: 1_000 });
    await open(page, GLOBEX);
    expect((await chat(page)).status).toBe(200);

    expect(await (await putAllowance(request, ACME, { unlimited: true })).json()).toEqual({ aiAllowance: { tokens: null, scope: "month" } });
    await spendMonth(ACME, (await monthlyLimit(ACME)) + 5_000_000);
    await open(page, ACME);
    expect((await chat(page)).status, "unlimited lifts the limit").toBe(200);

    expect((await putAllowance(request, ACME, { tokens: null })).status()).toBe(200);
    await spendMonth(ACME, (await monthlyLimit(ACME)) + 5_000_000);
    await open(page, ACME);
    expect((await chat(page)).status, "null gives it its plan's figure back").toBe(429);

    const rows = await auditRows();
    expect(rows.map((row) => [row.action, row.detail])).toEqual([
      ["ai_allowance_set", "1000 (month): abuse, invoice 42"],
      ["ai_allowance_set", "no limit (month)"],
      ["ai_allowance_cleared", ""],
    ]);
    for (const row of rows) {
      expect(String(row.subject)).toBe(ACME.organisation.toHexString());
      expect(row).not.toHaveProperty("organisation");
    }
  });

  test("shows in the platform list what each organisation has spent against its figure, and whose figure it is", async ({ request }) => {
    await spendMonth(ACME, 500);
    await spendMonth(GLOBEX, 700);
    expect((await putAllowance(request, ACME, { tokens: 2_000_000 })).status()).toBe(200);

    const rows = await listed(request);

    expect(rows.acme.ai).toMatchObject({ scope: "month", included: true, used: 500, ownTokens: 0, limit: 2_000_000, overridden: true, resetsAt: expect.stringMatching(/^\d{4}-\d{2}-01T00:00:00\.000Z$/) });
    expect(rows.globex.ai).toMatchObject({ scope: "month", included: true, used: 700, ownTokens: 0, limit: await monthlyLimit(GLOBEX), overridden: false });
  });

  test("refuses what is not a whole number of tokens, an unknown organisation, and says nothing is stored", async ({ request }) => {
    for (const body of [{ tokens: 0 }, { tokens: -1 }, { tokens: 1.5 }, { tokens: "5" }, { tokens: 1e13 }, {}, { unlimited: false }, { unlimited: 1 }, { unlimited: true, tokens: 5 }, { tokens: 5, reason: "x".repeat(501) }, []]) {
      const response = await putAllowance(request, ACME, body);
      expect(response.status(), JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    const unknown = { ...ACME, organisation: new mongoose.Types.ObjectId() } as OrganisationFixture;
    expect((await putAllowance(request, unknown, { tokens: 5 })).status()).toBe(404);
    for (const state of ["deletedAt", "deletingAt"]) {
      await withDb((db) => db.collection("organisations").updateOne({ _id: GLOBEX.organisation }, { $set: { [state]: new Date() } }));
      expect((await putAllowance(request, GLOBEX, { tokens: 5 })).status(), state).toBe(404);
      await withDb((db) => db.collection("organisations").updateOne({ _id: GLOBEX.organisation }, { $set: { [state]: null } }));
    }

    expect(await auditRows()).toEqual([]);
    expect(await withDb((db) => db.collection("organisations").findOne({ _id: ACME.organisation }))).not.toHaveProperty("aiAllowance");
    expect(await withDb((db) => db.collection("organisations").findOne({ _id: GLOBEX.organisation }))).not.toHaveProperty("aiAllowance");
  });

  test("is not in the hands of an organisation's administrator, by session, API token or OAuth token, on either host", async ({ request }) => {
    const credentials = { session: { cookie: `__Host-bp_session=${ACME.sessionToken}` }, token: bearer(ACME), oauth: oauthBearer(ACME) };
    for (const target of [ACME, GLOBEX]) {
      const path = `/api/platform/organisations/${target.organisation.toHexString()}/ai-allowance`;
      for (const [kind, credential] of Object.entries(credentials)) {
        const send = (headers: Record<string, string>) => request.put(`${ORGANISATIONS_API}${path}`, { headers: { ...headers, "content-type": "application/json" }, data: JSON.stringify({ unlimited: true }) });
        expect((await send({ host: PLATFORM_HOST, ...credential })).status(), `${kind} on ${target.slug}, platform host`).toBe(401);
        expect((await send({ ...asOrganisation(ACME), ...credential })).status(), `${kind} on ${target.slug}, its own host`).toBe(404);
      }
    }
    const rows = await withDb((db) => db.collection("organisations").find({ _id: { $in: [ACME.organisation, GLOBEX.organisation] } }).toArray());
    for (const row of rows) expect(row, `${row.slug} allowance`).not.toHaveProperty("aiAllowance");
    expect(await auditRows()).toEqual([]);
  });
  test("a figure set during a month is not a trial's, and the plan's figure applies again once the organisation is on the other counter", async ({ page, request }) => {
    expect((await putAllowance(request, ACME, { tokens: 1_000 })).status()).toBe(200);
    await makePro(request, ACME, true);

    const row = (await listed(request)).acme.ai;
    expect(row).toMatchObject({ scope: "trial", limit: 3_000_000, overridden: false });
    await open(page, ACME);
    expect((await chat(page)).status).toBe(200);
  });

  test("says that an organisation whose plan has no managed AI has no limit to set", async ({ request }) => {
    await withDb((db) => db.collection("organisations").updateOne({ _id: GLOBEX.organisation }, { $unset: { licenceKey: 1 } }));

    expect((await listed(request)).globex.ai).toMatchObject({ included: false, limit: null, used: 0 });
  });
});
