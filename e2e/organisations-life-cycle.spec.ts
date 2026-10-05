import { test, expect, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import mongoose from "mongoose";
import { RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { signPlatformRequest } from "../src/lib/platform-request";
import { E2E_PLATFORM_REQUEST_KEY } from "./licence-key";
import { E2E_MONGODB_URI } from "./seed";
import {
  ACME,
  GLOBEX,
  ORGANISATIONS_API,
  PLATFORM_HOST,
  SHARED_KEY,
  asOrganisation,
  bearer,
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
const { EJSON } = mongoose.mongo.BSON;

function platform(request: APIRequestContext, method: "POST" | "DELETE", path: string, data?: object) {
  const body = data ? Buffer.from(JSON.stringify(data)) : new Uint8Array();
  return request.fetch(`${ORGANISATIONS_API}${path}`, {
    method,
    headers: {
      host: PLATFORM_HOST,
      ...(data ? { "content-type": "application/json" } : {}),
      ...signPlatformRequest({ method, path, body }, E2E_PLATFORM_REQUEST_KEY),
    },
    ...(data ? { data: body } : {}),
  });
}

const organisationPath = (who: OrganisationFixture) => `/api/platform/organisations/${who.organisation.toHexString()}`;
const suspend = (request: APIRequestContext, who: OrganisationFixture) => platform(request, "POST", `${organisationPath(who)}/suspend`, { reason: "unpaid" });
const resume = (request: APIRequestContext, who: OrganisationFixture) => platform(request, "POST", `${organisationPath(who)}/resume`);
const remove = (request: APIRequestContext, who: OrganisationFixture, query: string) => platform(request, "DELETE", `${organisationPath(who)}?${query}`);

const projects = (request: APIRequestContext, who: OrganisationFixture) =>
  request.get(`${ORGANISATIONS_API}/api/projects`, { headers: { ...asOrganisation(who), ...bearer(who) } });

function upload(request: APIRequestContext, who: OrganisationFixture) {
  return request.post(`${ORGANISATIONS_API}/api/uploads`, {
    headers: { ...asOrganisation(who), ...bearer(who) },
    multipart: { file: { name: `${who.slug}.png`, mimeType: "image/png", buffer: TINY_PNG }, projectId: String(who.projectId) },
  });
}

async function withDb<T>(work: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await work(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

// Every document in every collection that names the organisation, however it names it
function rowsNaming(who: OrganisationFixture) {
  return withDb(async (db) => {
    const found: Record<string, number> = {};
    for (const { name } of await db.listCollections().toArray()) {
      if (name === "organisations" || name === "platformauditlogs") continue;
      const count = await db.collection(name).countDocuments({
        $or: [{ organisation: who.organisation }, { "metadata.organisation": who.organisation }],
      });
      if (count > 0) found[name] = count;
    }
    return found;
  });
}

// As if the suspension had been in place long enough for work admitted before it to have finished
const settle = (who: OrganisationFixture) =>
  withDb((db) => db.collection("organisations").updateOne({ _id: who.organisation }, { $set: { suspendedAt: new Date(Date.now() - 11 * 60 * 1000) } }));

const orphanChunks = () =>
  withDb(async (db) => {
    const files = new Set((await db.collection("uploads.files").find({}, { projection: { _id: 1 } }).toArray()).map((row) => String(row._id)));
    const chunks = await db.collection("uploads.chunks").find({}, { projection: { files_id: 1 } }).toArray();
    return chunks.filter((chunk) => !files.has(String(chunk.files_id))).length;
  });

const platformActions = () => withDb(async (db) => (await db.collection("platformauditlogs").find({}).sort({ _id: 1 }).toArray()).map((row) => row.action));

test.beforeEach(async ({ request }) => {
  await seedTwoOrganisations();
  expect((await request.post(`${ORGANISATIONS_API}/api/e2e/organisation-cache`, { headers: asOrganisation(ACME) })).status()).toBe(204);
});

test.afterEach(async ({ request }) => {
  await request.post(`${ORGANISATIONS_API}/api/e2e/organisation-cache`, { headers: asOrganisation(ACME) });
});

test.describe("BP-893: an organisation's life cycle", () => {
  test("a suspended organisation is refused everywhere on its host, keeps its data, and comes back when resumed; the other is untouched", async ({ request }) => {
    expect((await suspend(request, GLOBEX)).status()).toBe(200);

    const refused = await projects(request, GLOBEX);
    expect(refused.status()).toBe(503);
    expect(await refused.json()).toEqual({ error: "This organisation is suspended.", suspended: true });
    const machine = await request.post(`${ORGANISATIONS_API}/api/workers/${GLOBEX.workerId}/heartbeat`, { headers: { ...asOrganisation(GLOBEX), ...workerHeaders(GLOBEX) }, data: {} });
    expect(machine.status()).toBe(503);
    expect((await request.get(`${ORGANISATIONS_API}/api/auth/instance`, { headers: asOrganisation(GLOBEX) })).status()).toBe(503);
    expect((await projects(request, ACME)).status()).toBe(200);
    expect(await rowsNaming(GLOBEX)).toMatchObject({ users: expect.any(Number), projects: 1 });

    expect((await resume(request, GLOBEX)).status()).toBe(200);
    expect((await projects(request, GLOBEX)).status()).toBe(200);
    expect(await platformActions()).toEqual(["organisation_suspended", "organisation_resumed"]);
  });

  test("on screen: a member of a suspended organisation is told so, signed in or not, and the other organisation works", async ({ browser, request }) => {
    expect((await suspend(request, GLOBEX)).status()).toBe(200);

    const signedIn = await browser.newContext();
    await signInOn(signedIn, GLOBEX);
    const page = await signedIn.newPage();
    await page.goto(`${originOf(GLOBEX)}/projects/${SHARED_KEY}`);
    await expect(page.getByRole("heading", { name: "This organisation is suspended" })).toBeVisible();
    await expect(page).toHaveURL(/\/projects\//);
    await page.screenshot({ path: "e2e/.artifacts/bp893-suspended-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByRole("heading", { name: "This organisation is suspended" })).toBeVisible();
    await page.screenshot({ path: "e2e/.artifacts/bp893-suspended-phone.png" });
    await signedIn.close();

    const visitor = await browser.newPage();
    await visitor.goto(`${originOf(GLOBEX)}/login`);
    await expect(visitor.getByRole("heading", { name: "This organisation is suspended" })).toBeVisible();
    await expect(visitor.getByLabel("Password")).toHaveCount(0);
    await visitor.close();

    const other = await browser.newContext();
    await signInOn(other, ACME);
    const acme = await other.newPage();
    await acme.goto(`${originOf(ACME)}/projects/${SHARED_KEY}`);
    await expect(acme.getByText(ACME.projectName).first()).toBeVisible();
    await other.close();
  });

  test("on screen: a page already open learns of the suspension at its next request, and comes back by itself once it is lifted", async ({ page, request }) => {
    test.setTimeout(90_000);
    await signInOn(page.context(), GLOBEX);
    await page.goto(`${originOf(GLOBEX)}/projects/${SHARED_KEY}`);
    await expect(page.getByText(GLOBEX.projectName).first()).toBeVisible();

    expect((await suspend(request, GLOBEX)).status()).toBe(200);
    await page.getByRole("link", { name: "My Tasks" }).click();
    await expect(page.getByRole("heading", { name: "This organisation is suspended" })).toBeVisible();
    await expect(page.getByText(/having trouble reaching its database/)).toHaveCount(0);

    expect((await resume(request, GLOBEX)).status()).toBe(200);
    await expect(page.getByRole("heading", { name: "This organisation is suspended" })).toHaveCount(0, { timeout: 30_000 });
  });

  test("on screen: the organisation's admin downloads everything it holds and nothing of another, with no credential in it", async ({ page, request }) => {
    expect((await upload(request, ACME)).status()).toBe(200);
    expect((await upload(request, GLOBEX)).status()).toBe(200);

    await withDb(async (db) => {
      await db.collection("projects").updateOne({ _id: ACME.projectId }, { $set: { githubToken: "enc:v3:e2e:sealed-github-token" } });
      await db.collection("users").updateOne({ _id: ACME.adminId }, { $set: { "notifications.chat": { kind: "slack", webhookUrl: "enc:v3:e2e:sealed-webhook" } } });
      await db.collection("tasks").insertOne({
        organisation: ACME.organisation,
        project: ACME.projectId,
        taskNumber: 900,
        title: "Held for a decision",
        status: "needs_human_review",
        decision: { patch: "diff --git a/acme-hidden-patch b/acme-hidden-patch", files: ["src/rocket.ts"] },
      });
    });

    await signInOn(page.context(), ACME);
    await page.goto(`${originOf(ACME)}/settings/export`);
    await expect(page.getByRole("heading", { name: "Export" })).toBeVisible();
    await page.screenshot({ path: "e2e/.artifacts/bp893-export-desktop.png" });
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download the export" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^acme-export-\d{4}-\d{2}-\d{2}\.ndjson\.gz$/);

    const text = gunzipSync(readFileSync((await download.path())!)).toString("utf8");
    const [header, ...rows] = text.trim().split("\n").map((line) => EJSON.parse(line) as Record<string, unknown>);
    expect(header).toMatchObject({ format: "board-planner-organisation-export", version: 1 });
    expect(String(header.organisation)).toBe(ACME.organisation.toHexString());

    const collections = new Set(rows.map((row) => row.collection));
    for (const kept of ["User", "Project", "ApiToken", "Worker", "uploads.files", "uploads.chunks"]) expect(collections, kept).toContain(kept);
    for (const left of ["Session", "OAuthToken"]) expect(collections, left).not.toContain(left);
    expect(text).not.toContain(GLOBEX.organisation.toHexString());
    expect(text).not.toContain(GLOBEX.projectName);
    expect(text).not.toMatch(/"[A-Za-z]*[Hh]ash"\s*:|"password"\s*:/);
    expect(text).not.toContain("enc:v3:");
    // A field the schema hides from every read is still the organisation's data
    expect(text).toContain("acme-hidden-patch");

    const user = rows.find((row) => row.collection === "User")!.document as Record<string, unknown>;
    expect(user.username).toBe("boss");
    await expect
      .poll(() => withDb(async (db) => db.collection("instanceauditlogs").countDocuments({ organisation: ACME.organisation, action: "organisation_exported" })))
      .toBe(1);
  });

  test("the operator can export a suspended organisation that can no longer sign in to take its own", async ({ request }) => {
    expect((await suspend(request, GLOBEX)).status()).toBe(200);
    const path = `${organisationPath(GLOBEX)}/export`;
    const response = await request.get(`${ORGANISATIONS_API}${path}`, {
      headers: { host: PLATFORM_HOST, ...signPlatformRequest({ method: "GET", path, body: new Uint8Array() }, E2E_PLATFORM_REQUEST_KEY) },
    });
    expect(response.status()).toBe(200);
    const text = gunzipSync(await response.body()).toString("utf8");
    expect(text).toContain(GLOBEX.projectName);
    expect(text).not.toContain(ACME.organisation.toHexString());
    await expect.poll(platformActions).toEqual(["organisation_suspended", "organisation_exported"]);
  });

  test("the operator deletes an organisation: counts first, only once suspended and named, then nothing of it remains and the other keeps everything", async ({ request }) => {
    expect((await upload(request, GLOBEX)).status()).toBe(200);
    const acmeBefore = await rowsNaming(ACME);

    const dryRun = await remove(request, GLOBEX, "dryRun=1");
    expect(dryRun.status()).toBe(200);
    expect((await dryRun.json()).counts).toMatchObject({ User: expect.any(Number), Project: 1, "uploads.files": 1 });
    expect(await rowsNaming(GLOBEX)).not.toEqual({});

    expect((await remove(request, GLOBEX, `confirm=${GLOBEX.slug}`)).status()).toBe(409);
    expect((await suspend(request, GLOBEX)).status()).toBe(200);
    const tooSoon = await remove(request, GLOBEX, `confirm=${GLOBEX.slug}`);
    expect(tooSoon.status()).toBe(409);
    expect((await tooSoon.json()).error).toMatch(/may still be writing; delete after /);
    await settle(GLOBEX);
    expect((await remove(request, GLOBEX, "confirm=acme")).status()).toBe(400);
    const deleted = await remove(request, GLOBEX, `confirm=${GLOBEX.slug}`);
    expect(deleted.status(), await deleted.text()).toBe(200);
    expect((await deleted.json()).counts).toMatchObject({ Project: 1, "uploads.files": 1 });

    expect(await rowsNaming(GLOBEX)).toEqual({});
    expect(await orphanChunks()).toBe(0);
    expect(await rowsNaming(ACME)).toEqual(acmeBefore);
    const tombstone = await withDb((db) => db.collection("organisations").findOne({ _id: GLOBEX.organisation }));
    expect(tombstone).toMatchObject({ slug: GLOBEX.slug, deletedAt: expect.any(Date) });
    expect(tombstone).not.toHaveProperty("licenceKey");
    expect((await request.get(`${ORGANISATIONS_API}/api/auth/instance`, { headers: asOrganisation(GLOBEX) })).status()).toBe(404);
    expect((await remove(request, GLOBEX, "dryRun=1")).status()).toBe(404);
    expect(await platformActions()).toEqual(["organisation_suspended", "organisation_deleted"]);
  });

  test("the default organisation can be neither suspended nor deleted", async ({ request }) => {
    const id = "000000000000000000000001";
    expect((await platform(request, "POST", `/api/platform/organisations/${id}/suspend`, { reason: "x" })).status()).toBe(409);
    expect((await platform(request, "DELETE", `/api/platform/organisations/${id}?dryRun=1`)).status()).toBe(409);
  });
});
