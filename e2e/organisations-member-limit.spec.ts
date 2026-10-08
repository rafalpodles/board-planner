import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { signPlatformRequest } from "../src/lib/platform-request";
import { E2E_PLATFORM_REQUEST_KEY, e2eLicence } from "./licence-key";
import { E2E_MONGODB_URI } from "./seed";
import {
  ACME,
  GLOBEX,
  ORGANISATIONS_API,
  PLATFORM_HOST,
  SHARED_KEY,
  originOf,
  seedTwoOrganisations,
  signInOn,
  type OrganisationFixture,
} from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

/**
 * BP-948. A Free cloud organisation holds ten members, pending invitations included; nobody loses access
 * past it, and Pro is not limited. ACME is Free, GLOBEX is made Pro. Each already has its administrator.
 */

async function withDb<T>(work: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await work(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

// `count` more people, so the organisation holds its administrator plus these
function addPeople(who: OrganisationFixture, count: number, deactivated = false) {
  return withDb(async (db) => {
    const docs = Array.from({ length: count }, (_, i) => ({
      organisation: who.organisation,
      username: `${deactivated ? "gone" : "crew"}${i}`,
      fullName: `${who.slug} ${deactivated ? "gone" : "crew"} ${i}`,
      email: `${deactivated ? "gone" : "crew"}${i}@${who.slug}.example`,
      kind: "human",
      role: "member",
      deactivatedAt: deactivated ? new Date() : null,
      createdAt: new Date(),
    }));
    return (await db.collection("users").insertMany(docs)).insertedIds;
  });
}

async function makePro(request: APIRequestContext, who: OrganisationFixture) {
  const path = `/api/platform/organisations/${who.organisation.toHexString()}/licence`;
  const body = Buffer.from(
    JSON.stringify({ licenceKey: e2eLicence({ customer: `${who.slug} customer`, organisation: who.organisation.toHexString() }) })
  );
  const headers = signPlatformRequest({ method: "POST", host: PLATFORM_HOST, path, body }, E2E_PLATFORM_REQUEST_KEY);
  const response = await request.post(`${ORGANISATIONS_API}${path}`, {
    headers: { host: PLATFORM_HOST, "content-type": "application/json", ...headers },
    data: body,
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** From inside the page, so the browser's own headers and cookie are on the request */
const send = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { method, path, body }
  );

async function openAs(page: Page, who: OrganisationFixture) {
  await signInOn(page.context(), who);
  await page.goto(`${originOf(who)}/projects/${SHARED_KEY}`);
}

const invite = (page: Page, email: string) => send(page, "POST", "/api/invitations", { email, role: "member", boards: [] });

test.beforeEach(async ({ request }) => {
  await seedTwoOrganisations();
  await request.post(`${ORGANISATIONS_API}/api/e2e/licence`, { data: {} }).catch(() => {});
});

test("a Free organisation with ten members is refused an eleventh invitation, naming the count and the limit", async ({ page }) => {
  await addPeople(ACME, 9);
  await openAs(page, ACME);

  const refused = await invite(page, "newcomer@acme.example");

  expect(refused.status).toBe(402);
  expect(refused.body).toMatchObject({ feature: "members.limit", plan: "free", members: 10, limit: 10 });
  expect(refused.body.error).toMatch(/holds 10 members/);
  const onABoard = await send(page, "POST", `/api/projects/${SHARED_KEY}/invitations`, { email: "boardy@acme.example", relation: "member" });
  expect(onABoard.status).toBe(402);
  expect(await withDb((db) => db.collection("invitations").countDocuments({ organisation: ACME.organisation }))).toBe(0);
});

test("a pending invitation holds a seat, and re-inviting the same address does not take a second one", async ({ page }) => {
  await addPeople(ACME, 8);
  await openAs(page, ACME);

  expect((await invite(page, "first@acme.example")).status).toBe(201);
  expect((await invite(page, "first@acme.example")).status).toBe(201);
  const eleventh = await invite(page, "second@acme.example");
  expect(eleventh.status).toBe(402);
  expect(eleventh.body).toMatchObject({ members: 10 });
});

test("an account is not created for the eleventh person either, and reactivating one is refused at ten", async ({ page }) => {
  await addPeople(ACME, 9);
  const [gone] = Object.values(await addPeople(ACME, 1, true));
  await openAs(page, ACME);

  expect((await send(page, "POST", "/api/users", { username: "eleven", fullName: "Eleven", email: "eleven@acme.example", password: "long-enough-pw-1" })).status).toBe(402);
  const reactivated = await send(page, "PUT", `/api/users/${gone}`, { reactivate: true });
  expect(reactivated.status).toBe(402);
  expect(await withDb((db) => db.collection("users").countDocuments({ organisation: ACME.organisation, deactivatedAt: null }))).toBe(10);
});

test("an organisation over the limit keeps everyone working, refuses additions, and shows its admin the banner", async ({ page }) => {
  await addPeople(ACME, 11);
  await openAs(page, ACME);

  expect((await send(page, "GET", `/api/projects/${SHARED_KEY}`)).status).toBe(200);
  expect((await invite(page, "newcomer@acme.example")).status).toBe(402);
  await expect(page.getByTestId("plan-badge-members")).toHaveText("12 of 10 members on Free");
  await expect(page.getByTestId("plan-badge-action")).toHaveText("Upgrade");
  await page.screenshot({ path: "e2e/.artifacts/bp948-banner.png" });
});

test("Pro is not limited: the eleventh and the twentieth are invited", async ({ page, request }) => {
  await addPeople(GLOBEX, 14);
  await makePro(request, GLOBEX);
  await openAs(page, GLOBEX);

  expect((await invite(page, "one@globex.example")).status).toBe(201);
  expect((await invite(page, "two@globex.example")).status).toBe(201);
  await expect(page.getByTestId("plan-badge-members")).toHaveCount(0);
});

test("the limit is each organisation's own: a full Free organisation does not stop another Free one with room", async ({ browser }) => {
  await addPeople(ACME, 9);
  await addPeople(GLOBEX, 1);
  const globex = await (await browser.newContext()).newPage();
  await openAs(globex, GLOBEX);

  expect((await invite(globex, "someone@globex.example")).status).toBe(201);
  const acme = await (await browser.newContext()).newPage();
  await openAs(acme, ACME);
  expect((await invite(acme, "someone@acme.example")).status).toBe(402);
});

test("a lapsed invitation holds no seat, so sending it again takes one, and is refused at ten", async ({ page }) => {
  await addPeople(ACME, 9);
  await withDb((db) =>
    db.collection("invitations").insertOne({
      organisation: ACME.organisation,
      email: "lapsed@acme.example",
      role: "member",
      boards: [],
      invitedBy: ACME.adminId,
      tokenHash: "lapsed-hash",
      expiresAt: new Date(Date.now() - 60_000),
      status: "pending",
      deliveredAs: null,
    })
  );
  await openAs(page, ACME);
  const lapsed = await withDb((db) => db.collection("invitations").findOne({ email: "lapsed@acme.example" }));

  const resent = await send(page, "POST", `/api/invitations/${lapsed!._id}/resend`, { delivery: "link" });

  expect(resent.status).toBe(402);
  expect(resent.body).toMatchObject({ members: 10, limit: 10 });
});
