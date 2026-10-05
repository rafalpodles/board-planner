import { test, expect, type APIRequestContext } from "@playwright/test";
import mongoose from "mongoose";
import { RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { E2E_MONGODB_URI } from "./seed";
import { CLOUD_REQUESTS_PER_MINUTE, CLOUD_STORAGE_MB, organisationRequestsKey } from "../src/lib/organisation-limits";
import {
  ACME,
  GLOBEX,
  ORGANISATIONS_API,
  SHARED_KEY,
  asOrganisation,
  bearer,
  originOf,
  seedTwoOrganisations,
  signInOn,
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

  test("on screen: the board says why it cannot load for the organisation over its limit, and loads for the other", async ({ page }) => {
    await spendTheMinute(ACME);

    await signInOn(page.context(), ACME);
    await page.goto(`${originOf(ACME)}/projects/${SHARED_KEY}`);
    await expect(page.getByRole("status").filter({ hasText: "Your organisation has made more requests this minute than it may." })).toContainText(
      /Pages will load again after \d/
    );
    await expect(page.getByRole("alert").filter({ hasText: "Failed to load this board." })).toBeVisible();
    await page.screenshot({ path: "e2e/.artifacts/bp894-limit-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "e2e/.artifacts/bp894-limit-phone.png" });

    await signInOn(page.context(), GLOBEX);
    await page.goto(`${originOf(GLOBEX)}/projects/${SHARED_KEY}`);
    await expect(page.getByText(GLOBEX.projectName).first()).toBeVisible();
    await expect(page.getByText(/more requests this minute/)).toHaveCount(0);
  });

  test("an organisation whose files fill its storage cannot upload another, while the other can", async ({ request }) => {
    await withDb((db) =>
      db.collection("uploads.files").insertOne({
        length: CLOUD_STORAGE_MB * 1024 * 1024,
        chunkSize: 255 * 1024,
        uploadDate: new Date(),
        filename: "archive.zip",
        metadata: { organisation: ACME.organisation, project: ACME.projectId },
      })
    );

    const refused = await upload(request, ACME);
    expect(refused.status()).toBe(413);
    expect((await refused.json()).error).toBe(
      `This organisation has used ${CLOUD_STORAGE_MB} MB of its ${CLOUD_STORAGE_MB} MB of file storage, so no more files can be uploaded.`
    );

    expect((await upload(request, GLOBEX)).status()).toBe(200);
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
