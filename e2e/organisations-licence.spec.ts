import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { generateKeyPairSync } from "node:crypto";
import mongoose from "mongoose";
import { RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { signPlatformRequest } from "../src/lib/platform-request";
import { E2E_PLATFORM_REQUEST_KEY, e2eLicence } from "./licence-key";
import {
  ACME,
  GLOBEX,
  ORGANISATIONS_API,
  PLATFORM_HOST,
  asOrganisation,
  bearer,
  originOf,
  seedTwoOrganisations,
  signInOn,
  type OrganisationFixture,
} from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

const DAY = 24 * 60 * 60 * 1000;

function stranger() {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  return { keyId: E2E_PLATFORM_REQUEST_KEY.keyId, d: jwk.d!, x: jwk.x! };
}
const pathFor = (who: OrganisationFixture) => `/api/platform/organisations/${who.organisation.toHexString()}/licence`;

const keyFor = (who: OrganisationFixture, overrides: { issuedAt?: string; plan?: "pro" | "free"; customer?: string } = {}) =>
  e2eLicence({ customer: `${who.slug} customer`, organisation: who.organisation.toHexString(), ...overrides });

function push(
  request: APIRequestContext,
  who: OrganisationFixture,
  licenceKey: string,
  { host = PLATFORM_HOST, headers }: { host?: string; headers?: Record<string, string> } = {}
) {
  const body = Buffer.from(JSON.stringify({ licenceKey }));
  const signed = headers ?? signPlatformRequest({ method: "POST", host, path: pathFor(who), body }, E2E_PLATFORM_REQUEST_KEY);
  return {
    headers: signed,
    send: () =>
      request.post(`${ORGANISATIONS_API}${pathFor(who)}`, {
        headers: { host, "content-type": "application/json", ...signed },
        data: body,
      }),
  };
}

async function planOf(request: APIRequestContext, who: OrganisationFixture): Promise<string> {
  const response = await request.get(`${ORGANISATIONS_API}/api/entitlements`, { headers: { ...asOrganisation(who), ...bearer(who) } });
  expect(response.status(), who.slug).toBe(200);
  return (await response.json()).plan;
}

async function openLicence(page: Page, who: OrganisationFixture) {
  await signInOn(page.context(), who);
  await page.goto(`${originOf(who)}/settings/licence`);
  await expect(page.getByRole("heading", { name: "Licence" })).toBeVisible();
}

const clearEnvironmentKey = (request: APIRequestContext) =>
  request.post(`${ORGANISATIONS_API}/api/e2e/licence`, { headers: asOrganisation(ACME), data: {} });

test.beforeEach(async ({ request }) => {
  await seedTwoOrganisations();
  await clearEnvironmentKey(request);
});

test.describe("BP-891: each organisation carries its own licence", () => {
  test("a key pushed for one organisation makes it Pro and leaves the other Free", async ({ request }) => {
    expect([await planOf(request, ACME), await planOf(request, GLOBEX)]).toEqual(["free", "free"]);

    const response = await push(request, ACME, keyFor(ACME)).send();
    expect(response.status(), await response.text()).toBe(200);
    expect(await response.json()).toMatchObject({ stored: true, plan: "pro" });

    expect(await planOf(request, ACME)).toBe("pro");
    expect(await planOf(request, GLOBEX)).toBe("free");
  });

  test("on screen: Settings → Licence shows each organisation its own plan", async ({ page, request }) => {
    expect((await push(request, ACME, keyFor(ACME)).send()).status()).toBe(200);

    await openLicence(page, ACME);
    await expect(page.getByTestId("licence-details")).toContainText("Pro");
    await expect(page.getByTestId("licence-details")).toContainText("acme customer");

    await page.context().clearCookies();
    await openLicence(page, GLOBEX);
    await expect(page.getByTestId("licence-free")).toContainText("Free plan");
  });

  test("a LICENCE_KEY on the instance changes nobody's plan", async ({ request }) => {
    const response = await request.post(`${ORGANISATIONS_API}/api/e2e/licence`, {
      headers: asOrganisation(ACME),
      data: { key: e2eLicence({ customer: "Everybody Ltd" }) },
    });
    expect(response.status()).toBe(204);
    try {
      expect([await planOf(request, ACME), await planOf(request, GLOBEX)]).toEqual(["free", "free"]);
    } finally {
      await clearEnvironmentKey(request);
    }
  });

  test("a key issued for one organisation is refused for another, and changes neither", async ({ request }) => {
    const response = await push(request, GLOBEX, keyFor(ACME)).send();

    expect(response.status()).toBe(422);
    expect((await response.json()).verdict).toBe("wrong_organisation");
    expect([await planOf(request, ACME), await planOf(request, GLOBEX)]).toEqual(["free", "free"]);
  });

  test("a floating key, with no organisation in it, is refused", async ({ request }) => {
    const response = await push(request, ACME, e2eLicence()).send();
    expect(response.status()).toBe(422);
    expect(await planOf(request, ACME)).toBe("free");
  });

  test("the same signed request sent twice is refused the second time, while a fresh signature of it is not", async ({ request }) => {
    const key = keyFor(ACME);
    const first = push(request, ACME, key);
    expect((await first.send()).status()).toBe(200);

    expect((await push(request, ACME, key, { headers: first.headers }).send()).status()).toBe(401);
    const resigned = await push(request, ACME, key).send();
    expect(resigned.status()).toBe(200);
    expect(await resigned.json()).toEqual({ stored: false, unchanged: true });
  });

  test("an unsigned request, one signed by a stranger, and a tampered one are refused alike", async ({ request }) => {
    const key = keyFor(ACME);
    const unsigned = await request.post(`${ORGANISATIONS_API}${pathFor(ACME)}`, {
      headers: { host: PLATFORM_HOST, "content-type": "application/json" },
      data: { licenceKey: key },
    });
    const foreign = await push(request, ACME, key, {
      headers: signPlatformRequest(
        { method: "POST", host: PLATFORM_HOST, path: pathFor(ACME), body: Buffer.from(JSON.stringify({ licenceKey: key })) },
        stranger()
      ),
    }).send();
    const signedForOther = signPlatformRequest(
      { method: "POST", host: PLATFORM_HOST, path: pathFor(ACME), body: Buffer.from(JSON.stringify({ licenceKey: keyFor(ACME, { plan: "free" }) })) },
      E2E_PLATFORM_REQUEST_KEY
    );
    const tampered = await push(request, ACME, key, { headers: signedForOther }).send();

    for (const response of [unsigned, foreign, tampered]) {
      expect(response.status()).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized" });
    }
    expect(await planOf(request, ACME)).toBe("free");
  });

  test("an older key never replaces a newer one, and the same key twice changes nothing", async ({ request }) => {
    const newer = keyFor(ACME, { issuedAt: new Date(Date.now() - DAY).toISOString(), customer: "newer" });
    const older = keyFor(ACME, { issuedAt: new Date(Date.now() - 2 * DAY).toISOString(), customer: "older" });

    expect((await push(request, ACME, newer).send()).status()).toBe(200);
    expect((await push(request, ACME, older).send()).status()).toBe(409);
    const again = await push(request, ACME, newer).send();
    expect(again.status()).toBe(200);
    expect(await again.json()).toEqual({ stored: false, unchanged: true });
  });

  test("the endpoint is not there on an organisation's own host, and not for an organisation that does not exist", async ({ request }) => {
    expect((await push(request, ACME, keyFor(ACME), { host: asOrganisation(ACME).host }).send()).status()).toBe(404);

    const ghost: OrganisationFixture = { ...ACME, organisation: new mongoose.Types.ObjectId("0000000000000000000ff0ff") };
    expect((await push(request, ghost, keyFor(ghost)).send()).status()).toBe(404);
  });
});

// BP-930: the sidebar says which plan this organisation is on, and until when
test.describe("BP-930: the plan badge above the agents", () => {
  const badge = (page: Page) => page.getByTestId("plan-badge");

  async function openApp(page: Page, who: OrganisationFixture) {
    await signInOn(page.context(), who);
    await page.goto(`${originOf(who)}/projects`);
    await expect(badge(page)).toBeVisible();
  }

  test("Free offers an administrator Upgrade, which opens the licence page", async ({ page }) => {
    await openApp(page, ACME);
    await expect(badge(page)).toContainText("Free");
    await page.screenshot({ path: "e2e/.artifacts/bp930-free.png" });
    await page.getByTestId("plan-badge-action").click();
    await page.waitForURL(/\/settings\/licence$/);
    await expect(page.getByTestId("licence-free")).toBeVisible();
  });

  test("Pro with more than 30 days left says the plan is active and offers nothing to renew", async ({ page, request }) => {
    expect((await push(request, ACME, keyFor(ACME)).send()).status()).toBe(200);
    await openApp(page, ACME);
    await expect(badge(page)).toContainText("Pro");
    await expect(page.getByTestId("plan-badge-detail")).toHaveText("Plan active");
    await expect(page.getByTestId("plan-badge-action")).toHaveCount(0);
  });

  test("Pro ending in 12 days counts them and offers Renew", async ({ page, request }) => {
    const ending = e2eLicence({ customer: "acme customer", organisation: ACME.organisation.toHexString(), expiresInDays: 12 });
    expect((await push(request, ACME, ending).send()).status()).toBe(200);
    await openApp(page, ACME);
    await expect(page.getByTestId("plan-badge-detail")).toContainText(/1[23] days left/);
    await expect(page.getByTestId("plan-badge-action")).toHaveText("Renew");
    await page.screenshot({ path: "e2e/.artifacts/bp930-ending.png" });
    await page.setViewportSize({ width: 390, height: 780 });
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(badge(page)).toBeVisible();
    await expect(page.getByTestId("plan-badge-action")).toBeVisible();
    await expect.poll(async () => (await badge(page).boundingBox())?.x).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: "e2e/.artifacts/bp930-ending-phone.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "e2e/.artifacts/bp930-ending-phone-dark.png" });
  });

  test("a trial is a Trial with its days and Upgrade", async ({ page, request }) => {
    const trial = e2eLicence({ customer: "acme trial", organisation: ACME.organisation.toHexString(), expiresInDays: 20, trial: true });
    expect((await push(request, ACME, trial).send()).status()).toBe(200);
    await openApp(page, ACME);
    await expect(badge(page)).toContainText("Trial");
    await expect(page.getByTestId("plan-badge-detail")).toContainText(/(19|20|21) days left/);
    await expect(page.getByTestId("plan-badge-action")).toHaveText("Upgrade");
    await page.screenshot({ path: "e2e/.artifacts/bp950-trial.png" });
  });

  // A stored key that has since run out is Free at once: the unit tests hold the clock for that. What the
  // server can be asked here is that a trial which has already ended is not taken in the first place, where
  // a paid key a few days past its end still is (the grace test below)
  test("a trial that has already ended is refused, and the organisation stays Free", async ({ page, request }) => {
    const ended = e2eLicence({ customer: "acme trial", organisation: ACME.organisation.toHexString(), expiresInDays: -1, trial: true });
    const response = await push(request, ACME, ended).send();

    expect(response.status()).toBe(422);
    expect((await response.json()).verdict).toBe("expired");
    await openApp(page, ACME);
    await expect(badge(page)).toContainText("Free");
    await expect(page.getByTestId("plan-badge-detail")).toHaveText("Free plan");
  });

  test("a licence past its end shows the grace period in force", async ({ page, request }) => {
    const lapsed = e2eLicence({ customer: "acme customer", organisation: ACME.organisation.toHexString(), expiresInDays: -3 });
    expect((await push(request, ACME, lapsed).send()).status()).toBe(200);
    await openApp(page, ACME);
    await expect(page.getByTestId("plan-badge-detail")).toContainText(/^Ended .* · until /);
    await expect(page.getByTestId("plan-badge-action")).toHaveText("Renew");
  });
});
