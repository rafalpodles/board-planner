import { test, expect, type APIRequestContext } from "@playwright/test";
import mongoose from "mongoose";
import { MAIL_SERVER, RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { signPlatformRequest } from "../src/lib/platform-request";
import { E2E_PLATFORM_REQUEST_KEY, e2eLicence } from "./licence-key";
import { E2E_MONGODB_URI } from "./seed";
import {
  ACME,
  GLOBEX,
  ORGANISATIONS_API,
  PLATFORM_HOST,
  asOrganisation,
  bearer,
  oauthBearer,
  originOf,
  seedTwoOrganisations,
  signInOn,
  type OrganisationFixture,
} from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

const EMPTY = new Uint8Array();

function signedGet(request: APIRequestContext, path: string, { sign = path }: { sign?: string } = {}) {
  return request.get(`${ORGANISATIONS_API}${path}`, {
    headers: { host: PLATFORM_HOST, ...signPlatformRequest({ method: "GET", path: sign, body: EMPTY }, E2E_PLATFORM_REQUEST_KEY) },
  });
}

function pushLicence(request: APIRequestContext, who: OrganisationFixture) {
  const path = `/api/platform/organisations/${who.organisation.toHexString()}/licence`;
  const body = Buffer.from(JSON.stringify({ licenceKey: e2eLicence({ customer: `${who.slug} customer`, organisation: who.organisation.toHexString() }) }));
  return request.post(`${ORGANISATIONS_API}${path}`, {
    headers: { host: PLATFORM_HOST, "content-type": "application/json", ...signPlatformRequest({ method: "POST", path, body }, E2E_PLATFORM_REQUEST_KEY) },
    data: body,
  });
}

async function platformLogRows(): Promise<Record<string, unknown>[]> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await mongoose.connection.db!.collection("platformauditlogs").find({}).sort({ _id: 1 }).toArray();
  } finally {
    await mongoose.disconnect();
  }
}

test.beforeEach(async () => {
  await seedTwoOrganisations();
});

test.describe("BP-892: the platform operator is the licence service, not an organisation's admin", () => {
  test("the operator lists every organisation with its plan and counts, nothing from inside them, and the listing is logged with no organisation", async ({ request }) => {
    expect((await pushLicence(request, ACME)).status()).toBe(200);

    const response = await signedGet(request, "/api/platform/organisations");
    expect(response.status(), await response.text()).toBe(200);
    const { organisations, next } = await response.json();
    expect(next).toBeNull();
    const bySlug = Object.fromEntries(organisations.map((row: { slug: string }) => [row.slug, row]));
    expect(bySlug.acme).toMatchObject({ id: ACME.organisation.toHexString(), plan: "pro", members: 1, projects: 1, licence: { verdict: "valid", customer: "acme customer" } });
    expect(bySlug.globex).toMatchObject({ id: GLOBEX.organisation.toHexString(), plan: "free", members: 1, projects: 1 });
    expect(JSON.stringify(organisations)).not.toContain(ACME.projectName);

    const rows = await platformLogRows();
    expect(rows.map((row) => row.action)).toEqual(["licence_stored", "organisations_listed"]);
    expect(String(rows[0].subject)).toBe(ACME.organisation.toHexString());
    expect(rows[0].keyId).toBe(E2E_PLATFORM_REQUEST_KEY.keyId);
    for (const row of rows) expect(row).not.toHaveProperty("organisation");
  });

  test("the listing pages by organisation, and a signature covers the query it was made for", async ({ request }) => {
    const first = await (await signedGet(request, "/api/platform/organisations?limit=1")).json();
    expect(first.organisations).toHaveLength(1);
    expect(first.next).toBe(first.organisations[0].id);

    const second = await (await signedGet(request, `/api/platform/organisations?limit=1&after=${first.next}`)).json();
    expect(second.organisations).toHaveLength(1);
    expect(second.organisations[0].id).not.toBe(first.organisations[0].id);

    const tampered = await signedGet(request, "/api/platform/organisations?limit=200", { sign: "/api/platform/organisations?limit=1" });
    expect(tampered.status()).toBe(401);
  });

  test("the operator reads the platform log newest first, a page at a time", async ({ request }) => {
    expect((await pushLicence(request, ACME)).status()).toBe(200);
    expect((await pushLicence(request, GLOBEX)).status()).toBe(200);

    const page = await (await signedGet(request, "/api/platform/audit?limit=1")).json();
    expect(page.entries).toEqual([expect.objectContaining({ action: "licence_stored", subject: GLOBEX.organisation.toHexString() })]);
    const older = await (await signedGet(request, `/api/platform/audit?limit=1&before=${page.next}`)).json();
    expect(older.entries).toEqual([expect.objectContaining({ action: "licence_stored", subject: ACME.organisation.toHexString() })]);
  });

  test("an organisation's administrator reaches none of it, by session, API token or OAuth token, on either host", async ({ request }) => {
    const credentials = {
      session: { cookie: `__Host-bp_session=${ACME.sessionToken}` },
      token: bearer(ACME),
      oauth: oauthBearer(ACME),
    };
    for (const path of ["/api/platform/organisations", "/api/platform/audit"]) {
      for (const [kind, credential] of Object.entries(credentials)) {
        const onPlatform = await request.get(`${ORGANISATIONS_API}${path}`, { headers: { host: PLATFORM_HOST, ...credential } });
        expect(onPlatform.status(), `${kind} ${path} on the platform host`).toBe(401);
        const onOwnHost = await request.get(`${ORGANISATIONS_API}${path}`, { headers: { ...asOrganisation(ACME), ...credential } });
        expect(onOwnHost.status(), `${kind} ${path} on its own host`).toBe(404);
      }
    }
    expect(await platformLogRows()).toEqual([]);
  });

  test("on screen: an organisation's administrator sees that mail works, not the platform's mail server or its login", async ({ page }) => {
    const summary = await page.request.get(`${ORGANISATIONS_API}/api/admin/email`, {
      headers: { ...asOrganisation(ACME), cookie: `__Host-bp_session=${ACME.sessionToken}` },
    });
    expect(await summary.json()).toEqual({ managedByPlatform: true, configured: true, from: MAIL_SERVER.from });

    await signInOn(page.context(), ACME);
    await page.goto(`${originOf(ACME)}/settings/email`);
    await expect(page.getByText("Sent by the service's own mail server.")).toBeVisible();
    await expect(page.getByText("Provided by the service")).toBeVisible();
    await expect(page.getByText(MAIL_SERVER.from)).toBeVisible();
    await expect(page.getByRole("button", { name: "Send a test message" })).toBeEnabled();
    const shown = await page.locator("main").innerText();
    expect(shown).not.toContain(`${MAIL_SERVER.host}:${MAIL_SERVER.port}`);
    expect(shown).not.toContain("Username");
    await page.screenshot({ path: "e2e/.artifacts/bp892-email-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByText("Provided by the service")).toBeVisible();
    await page.screenshot({ path: "e2e/.artifacts/bp892-email-phone.png" });
  });
});
