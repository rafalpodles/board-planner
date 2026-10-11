import { test, expect, type APIRequestContext } from "@playwright/test";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { ORGANISATION_DOMAIN, RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { E2E_MONGODB_URI } from "./seed";
import { CLOUD_REQUESTS_PER_MINUTE, organisationRequestsKey, principalRequestsKey } from "../src/lib/organisation-limits";
import { FREE_STORAGE_MB, PAID_STORAGE_MB } from "../src/lib/storage-size";
import {
  ACME,
  GLOBEX,
  ORGANISATIONS_API,
  SHARED_KEY,
  asOrganisation,
  bearer,
  makePro,
  originOf,
  seedTwoOrganisations,
  signInOn,
  workerHeaders,
  type OrganisationFixture,
} from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

async function withDb<T>(work: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await work(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

// The minute's counter as if the organisation had already spent it
function spendTheMinute(who: OrganisationFixture) {
  return withDb((db) =>
    db.collection<{ _id: string; count: number; resetAt: Date }>("ratelimits").updateOne(
      { _id: organisationRequestsKey(who.organisation) },
      { $set: { count: CLOUD_REQUESTS_PER_MINUTE, resetAt: new Date(Date.now() + 60_000) } },
      { upsert: true }
    )
  );
}

// A member of the board who is not an administrator, signed in through a session of their own
async function aMember(who: OrganisationFixture): Promise<string> {
  const sessionToken = `cps_member_${who.slug}_${crypto.randomBytes(8).toString("hex")}`;
  const now = new Date();
  const later = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  await withDb(async (db) => {
    const { insertedId: member } = await db.collection("users").insertOne({
      organisation: who.organisation,
      username: "crew",
      fullName: `${who.slug} crew`,
      email: `crew@${who.slug}.example`,
      kind: "human",
      role: "member",
      createdAt: now,
    });
    await db.collection("grants").insertOne({ organisation: who.organisation, subject: member, relation: "member", objectType: "project", object: who.projectId, createdAt: now });
    await db.collection("sessions").insertOne({
      organisation: who.organisation,
      tokenHash: crypto.createHash("sha256").update(sessionToken).digest("hex"),
      user: member,
      expiresAt: later,
      absoluteExpiresAt: later,
      lastUsedAt: now,
      userAgent: "",
      ip: "",
      createdAt: now,
    });
  });
  return sessionToken;
}

const counted = (key: string) =>
  withDb(async (db) => (await db.collection<{ _id: string; count: number }>("ratelimits").findOne({ _id: key }))?.count ?? 0);

const tasks = (request: APIRequestContext, who: OrganisationFixture) =>
  request.get(`${ORGANISATIONS_API}/api/projects/${SHARED_KEY}/tasks`, { headers: { ...asOrganisation(who), ...bearer(who) } });

const upload = (request: APIRequestContext, who: OrganisationFixture) =>
  request.post(`${ORGANISATIONS_API}/api/uploads`, {
    headers: { ...asOrganisation(who), ...bearer(who) },
    multipart: { file: { name: "plan.png", mimeType: "image/png", buffer: TINY_PNG }, projectId: String(who.projectId) },
  });

const invite = (request: APIRequestContext, who: OrganisationFixture, email: string) =>
  request.post(`${ORGANISATIONS_API}/api/projects/${who.projectId}/invitations`, {
    headers: {
      ...asOrganisation(who),
      cookie: `__Host-bp_session=${who.sessionToken}`,
      origin: originOf(who),
      "content-type": "application/json",
    },
    data: { email },
  });

test.beforeEach(async () => {
  await seedTwoOrganisations();
});

test.describe("BP-894: one organisation's limits do not touch another's", () => {
  test("an organisation past its requests for the minute is refused, saying when it resets, while the other is served", async ({ request }) => {
    expect((await tasks(request, ACME)).status()).toBe(200);
    await spendTheMinute(ACME);

    const refused = await tasks(request, ACME);
    expect(refused.status()).toBe(429);
    const seconds = Number(refused.headers()["retry-after"]);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(60);
    const body = await refused.json();
    expect(body.error).toBe(`This organisation has made more than ${CLOUD_REQUESTS_PER_MINUTE} requests in a minute. Try again in ${seconds} s.`);
    expect(new Date(body.resetAt).getTime()).toBeGreaterThan(Date.now());

    expect((await tasks(request, GLOBEX)).status()).toBe(200);
  });

  test("on screen: a member over the organisation's minute is told so and until when, its administrator still gets in, and the other organisation is untouched", async ({ browser }) => {
    const memberSession = await aMember(ACME);
    await spendTheMinute(ACME);

    const member = await browser.newContext();
    await member.addCookies([
      { name: "__Host-bp_session", value: memberSession, domain: `${ACME.slug}.${ORGANISATION_DOMAIN}`, path: "/", httpOnly: true, secure: true, sameSite: "Lax" },
    ]);
    const page = await member.newPage();
    await page.goto(`${originOf(ACME)}/projects/${SHARED_KEY}`);
    await expect(page.getByRole("status").filter({ hasText: "Your organisation has made more requests this minute than it may." })).toContainText(
      /Try again after \d/
    );
    await expect(page.getByRole("alert").filter({ hasText: "Failed to load this board." })).toBeVisible();
    await page.screenshot({ path: "e2e/.artifacts/bp894-limit-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByRole("status").filter({ hasText: "Your organisation has made more requests this minute" })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "Failed to load this board." })).toBeVisible();
    await page.screenshot({ path: "e2e/.artifacts/bp894-limit-phone.png" });
    // BP-921: the banner sat above a full-height shell, so the page grew by its height and the bottom of the screen went out of reach
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(844);
    const main = await page.locator("main").boundingBox();
    expect(main!.y + main!.height).toBeLessThanOrEqual(844);
    await member.close();

    // Signed in as the administrator, who must be able to stop whoever is spending the minute
    const admin = await browser.newContext();
    await signInOn(admin, ACME);
    const adminPage = await admin.newPage();
    await adminPage.goto(`${originOf(ACME)}/projects/${SHARED_KEY}`);
    await expect(adminPage.getByText(ACME.projectName).first()).toBeVisible();
    await expect(adminPage.getByText(/more requests this minute/)).toHaveCount(0);
    await admin.close();

    const other = await browser.newContext();
    await signInOn(other, GLOBEX);
    const otherPage = await other.newPage();
    await otherPage.goto(`${originOf(GLOBEX)}/projects/${SHARED_KEY}`);
    await expect(otherPage.getByText(GLOBEX.projectName).first()).toBeVisible();
    await other.close();
  });

  test("every authenticated way in counts once, against the caller and its organisation, and nothing anonymous or foreign counts at all", async ({ request }) => {
    const on = (who: OrganisationFixture, extra: Record<string, string>) => ({ headers: { ...asOrganisation(who), ...extra } });
    // A wrong token, another organisation's token, and another organisation's machine, all on Acme's host
    expect((await request.get(`${ORGANISATIONS_API}/api/projects`, on(ACME, { authorization: "Bearer cp_nobody" }))).status()).toBe(401);
    expect((await request.get(`${ORGANISATIONS_API}/api/projects`, on(ACME, bearer(GLOBEX)))).status()).toBe(401);
    expect((await request.post(`${ORGANISATIONS_API}/api/workers/${GLOBEX.workerId}/heartbeat`, { ...on(ACME, workerHeaders(GLOBEX)), data: {} })).status()).toBe(401);
    expect(await counted(organisationRequestsKey(ACME.organisation))).toBe(0);

    await request.get(`${ORGANISATIONS_API}/api/projects`, on(ACME, bearer(ACME)));
    await request.get(`${ORGANISATIONS_API}/api/projects/${SHARED_KEY}/tasks`, on(ACME, bearer(ACME)));
    await request.get(`${ORGANISATIONS_API}/api/projects/${SHARED_KEY}`, on(ACME, bearer(ACME)));
    await request.post(`${ORGANISATIONS_API}/api/projects/${SHARED_KEY}/pm/chat`, { ...on(ACME, bearer(ACME)), data: { message: "hello" } });
    await request.post(`${ORGANISATIONS_API}/api/workers/${ACME.workerId}/heartbeat`, { ...on(ACME, workerHeaders(ACME)), data: {} });
    await request.get(`${ORGANISATIONS_API}/api/projects/${ACME.projectId}/runs`, on(ACME, workerHeaders(ACME)));

    expect(await counted(organisationRequestsKey(ACME.organisation))).toBe(6);
    // The machine is the administrator's, so it spends the administrator's share, not one of its own
    expect(await counted(principalRequestsKey(String(ACME.adminId)))).toBe(6);
    expect(await counted(principalRequestsKey(String(ACME.workerId)))).toBe(0);
    expect(await counted(organisationRequestsKey(GLOBEX.organisation))).toBe(0);
    expect(await counted(principalRequestsKey(String(GLOBEX.adminId)))).toBe(0);
  });

  const filesOf = (who: OrganisationFixture, megabytes: number) =>
    withDb((db) =>
      db.collection("uploads.files").insertOne({
        length: megabytes * 1024 * 1024,
        chunkSize: 255 * 1024,
        uploadDate: new Date(),
        filename: "archive.zip",
        metadata: { organisation: who.organisation, project: who.projectId },
      })
    );

  test("a Free organisation whose files fill its 1 GB cannot upload another, Pro lifts it, and the other organisation is untouched (BP-967)", async ({ request }) => {
    await filesOf(ACME, FREE_STORAGE_MB);

    const refused = await upload(request, ACME);
    expect(refused.status()).toBe(413);
    expect((await refused.json()).error).toBe(
      "This organisation has used 1 GB of its 1 GB of file storage on the Free plan, so no more files can be uploaded. Upgrade to Pro for 20 GB."
    );
    expect((await upload(request, GLOBEX)).status()).toBe(200);

    await makePro(request, ACME);
    expect((await upload(request, ACME)).status()).toBe(200);
  });

  test("a Pro organisation stops at 20 GB and is pointed to Enterprise, not offered an upgrade (BP-967)", async ({ request }) => {
    await makePro(request, ACME);
    await filesOf(ACME, PAID_STORAGE_MB);

    const refused = await upload(request, ACME);
    expect(refused.status()).toBe(413);
    expect((await refused.json()).error).toBe(
      "This organisation has used 20 GB of its 20 GB of file storage, so no more files can be uploaded. Write to contact@board-planner.com about Enterprise for more."
    );
    expect((await upload(request, GLOBEX)).status()).toBe(200);
  });

  test("on screen: a full Pro organisation is told to write about Enterprise, with the address as a link (BP-967)", async ({ browser, request }) => {
    await makePro(request, ACME);
    await filesOf(ACME, PAID_STORAGE_MB);
    const admin = await browser.newContext();
    await signInOn(admin, ACME);
    const page = await admin.newPage();
    await page.goto(`${originOf(ACME)}/settings/organisation`);

    await expect(page.getByTestId("organisation-storage-used")).toHaveText("20 GB of 20 GB");
    const full = page.getByTestId("organisation-storage-full");
    await expect(full).toHaveText("Full, so no more files can be uploaded. Write to contact@board-planner.com about Enterprise for more.");
    await expect(full.getByRole("link", { name: "contact@board-planner.com" })).toHaveAttribute("href", "mailto:contact@board-planner.com");
    await expect(page.getByTestId("organisation-storage-free")).toHaveCount(0);
    await page.screenshot({ path: "e2e/.artifacts/bp967-storage-pro-full-desktop.png" });
    await admin.close();
  });

  test("on screen: Settings → Organisation shows an administrator the storage used against the plan, full on Free and 20 GB on Pro (BP-967)", async ({ browser, request }) => {
    await filesOf(ACME, 300);
    const admin = await browser.newContext();
    await signInOn(admin, ACME);
    const page = await admin.newPage();
    await page.goto(`${originOf(ACME)}/settings/organisation`);

    await expect(page.getByTestId("organisation-storage-used")).toHaveText("300 MB of 1 GB");
    await expect(page.getByRole("progressbar", { name: "File storage used" })).toHaveAttribute("aria-valuenow", String(300 * 1024 * 1024));
    await expect(page.getByTestId("organisation-storage-free")).toHaveText("Pro includes 20 GB.");
    await expect(page.getByTestId("organisation-storage-full")).toHaveCount(0);
    await page.screenshot({ path: "e2e/.artifacts/bp967-storage-desktop.png" });

    await filesOf(ACME, FREE_STORAGE_MB);
    await page.reload();
    await expect(page.getByTestId("organisation-storage-used")).toHaveText("1.3 GB of 1 GB");
    await expect(page.getByTestId("organisation-storage-full")).toHaveText("Full, so no more files can be uploaded. Upgrade to Pro for 20 GB.");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByTestId("organisation-storage-full")).toBeVisible();
    await page.screenshot({ path: "e2e/.artifacts/bp967-storage-full-phone.png" });

    await makePro(request, ACME);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload();
    await expect(page.getByTestId("organisation-storage-used")).toHaveText("1.3 GB of 20 GB");
    await expect(page.getByTestId("organisation-storage-full")).toHaveCount(0);
    await expect(page.getByTestId("organisation-storage-free")).toHaveCount(0);
    await admin.close();

    const other = await browser.newContext();
    await signInOn(other, GLOBEX);
    const otherPage = await other.newPage();
    await otherPage.goto(`${originOf(GLOBEX)}/settings/organisation`);
    await expect(otherPage.getByTestId("organisation-storage-used")).toHaveText("0 MB of 1 GB");
    await other.close();
  });

  test("invitations to one address are counted per organisation, so one cannot use up another's", async ({ request }) => {
    const address = "wanted@elsewhere.example";
    const session = (who: OrganisationFixture) => ({ ...asOrganisation(who), cookie: `__Host-bp_session=${who.sessionToken}`, origin: originOf(who) });
    // Only a new invitation sends mail and counts, so each round withdraws the last one first
    for (let i = 0; i < 5; i++) {
      const sent = await invite(request, ACME, address);
      expect(sent.status(), await sent.text()).toBe(201);
      const pending = (await (await request.get(`${ORGANISATIONS_API}/api/invitations`, { headers: session(ACME) })).json()) as { _id: string; email: string }[];
      const mine = pending.find((invitation) => invitation.email === address)!;
      expect((await request.delete(`${ORGANISATIONS_API}/api/invitations/${mine._id}`, { headers: session(ACME) })).status()).toBe(200);
    }
    expect((await invite(request, ACME, address)).status()).toBe(429);

    const theirs = await invite(request, GLOBEX, address);
    expect(theirs.status(), await theirs.text()).toBe(201);
  });
});
