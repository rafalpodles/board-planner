import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { OIDC_STUB_URL, ORGANISATIONS_RELAY_ORIGIN, RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { E2E_MONGODB_URI } from "./seed";
import { ACME, GLOBEX, SSO_CLIENT, SSO_LABEL, makePro, originOf, seedTwoOrganisations, signInOn, storeSso, type OrganisationFixture } from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

/**
 * BP-951. In the cloud an organisation's own OpenID Connect provider is set on Settings → Single sign-on, sealed under
 * the organisation's key, offered on that organisation's host only, and only while its plan (or its trial) includes it.
 * ACME is the organisation that sets one up; GLOBEX never does it and is a bystander.
 */

async function withDb<T>(work: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await work(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

async function script(body: Record<string, unknown>) {
  const res = await fetch(`${OIDC_STUB_URL}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.ok, "the OIDC stub refused its script").toBe(true);
}

const confirmAddress = (who: OrganisationFixture) => withDb((db) => db.collection("users").updateOne({ _id: who.adminId }, { $set: { emailVerifiedAt: new Date() } }));

// From the organisation's own page, so the browser sends what a browser sends: the session cookie and the same-origin marker
async function putFrom(page: Page, who: OrganisationFixture, body: Record<string, unknown>) {
  return page.evaluate(
    async (data) => {
      const res = await fetch("/api/settings/sso", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    { ...body }
  );
}

async function openSettings(page: Page, who: OrganisationFixture) {
  await signInOn(page.context(), who);
  await page.goto(`${originOf(who)}/settings/sso`);
  await expect(page.getByRole("heading", { name: "Single sign-on" })).toBeVisible();
}

test.beforeEach(async () => {
  await seedTwoOrganisations();
});

test.describe("BP-951: an organisation's own sign-in provider", () => {
  test("an administrator of a Pro organisation sets it up, and people then sign in with it", async ({ page, browser, request }) => {
    await makePro(request, ACME);
    await openSettings(page, ACME);
    await expect(page.getByTestId("sso-redirect")).toContainText(`${ORGANISATIONS_RELAY_ORIGIN}/api/auth/oidc/oidc/relay`);

    await page.getByLabel("Button name").fill(SSO_LABEL);
    await page.getByLabel("Issuer").fill(OIDC_STUB_URL);
    await page.getByLabel("Client ID").fill(SSO_CLIENT.clientId);
    await page.getByLabel("Client secret").fill(SSO_CLIENT.clientSecret);
    await page.getByRole("button", { name: "Save provider" }).click();

    await expect(page.getByText("Sign-in provider saved")).toBeVisible();
    await expect(page.getByText("Signing in", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Client secret")).toHaveValue("");
    await expect(page.getByLabel("Client secret")).toHaveAttribute("placeholder", /ending in/);
    await page.screenshot({ path: "e2e/.artifacts/bp951-settings.png" });

    // The secret is sealed under the organisation, and nothing the page reads says it
    const stored = await withDb((db) => db.collection("settings").findOne({ organisation: ACME.organisation }));
    expect(stored?.sso.clientSecret).toMatch(/^enc:v3:/);
    expect(JSON.stringify(stored?.sso)).not.toContain(SSO_CLIENT.clientSecret);
    const answer = await page.evaluate(async () => (await fetch("/api/settings/sso")).text());
    expect(answer).not.toContain(SSO_CLIENT.clientSecret);

    // Somebody who is not signed in uses it
    await confirmAddress(ACME);
    await script({ sub: `sub-acme-${Date.now()}`, email: `boss@${ACME.slug}.example`, email_verified: true });
    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(`${originOf(ACME)}/login`);
    await visitor.getByRole("button", { name: `Continue with ${SSO_LABEL}` }).click();
    await expect(visitor).toHaveURL(`${originOf(ACME)}/projects`);
  });

  test("another organisation is not offered it and cannot start a sign-in through it", async ({ page, request }) => {
    await makePro(request, ACME);
    await makePro(request, GLOBEX);
    await storeSso(ACME);

    await page.goto(`${originOf(GLOBEX)}/login`);
    await expect(page.getByRole("button", { name: /^Continue with/ })).toHaveCount(0);
    expect(await (await page.request.get(`${originOf(GLOBEX)}/api/auth/oidc/providers`)).json()).toEqual([]);

    await page.goto(`${originOf(ACME)}/login`);
    await expect(page.getByRole("button", { name: `Continue with ${SSO_LABEL}` })).toBeVisible();
    expect(await (await page.request.get(`${originOf(ACME)}/api/auth/oidc/providers`)).json()).toEqual([{ id: "oidc", label: SSO_LABEL }]);

    const started = await page.evaluate(async (origin) => (await fetch(`${origin}/api/auth/oidc/oidc/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, originOf(GLOBEX));
    expect(started).not.toBe(200);
  });

  test("a Free organisation is told it is part of Pro and the trial, and the server refuses it with a 402", async ({ page }) => {
    await openSettings(page, GLOBEX);

    await expect(page.getByTestId("sso-upgrade")).toContainText("included in Pro and in the trial");
    await expect(page.getByTestId("sso-form")).toHaveCount(0);
    const refused = await putFrom(page, GLOBEX, { issuer: OIDC_STUB_URL, clientId: SSO_CLIENT.clientId, clientSecret: SSO_CLIENT.clientSecret });
    expect(refused.status).toBe(402);
    expect(refused.body).toMatchObject({ feature: "identity.sso", plan: "free" });
    expect(await withDb((db) => db.collection("settings").findOne({ organisation: GLOBEX.organisation, sso: { $exists: true } }))).toBeNull();
    await page.screenshot({ path: "e2e/.artifacts/bp951-free.png" });
  });

  test("what was stored stays while the plan does not include it, and is offered again with the plan", async ({ page, request }) => {
    await storeSso(GLOBEX);

    await page.goto(`${originOf(GLOBEX)}/login`);
    await expect(page.getByRole("button", { name: /^Continue with/ })).toHaveCount(0);

    await makePro(request, GLOBEX);
    await page.goto(`${originOf(GLOBEX)}/login`);
    await expect(page.getByRole("button", { name: `Continue with ${SSO_LABEL}` })).toBeVisible();
  });

  test("refuses an address inside the network, and a provider that does not answer", async ({ page, request }) => {
    await makePro(request, ACME);
    await openSettings(page, ACME);

    const inside = await putFrom(page, ACME, { issuer: "https://10.0.0.1", clientId: SSO_CLIENT.clientId, clientSecret: SSO_CLIENT.clientSecret });
    expect(inside.status).toBe(400);
    expect(inside.body.error).toContain("not one this server may call");

    const silent = await putFrom(page, ACME, { issuer: "https://127.0.0.1:9", clientId: SSO_CLIENT.clientId, clientSecret: SSO_CLIENT.clientSecret });
    expect(silent.status).toBe(400);
    expect(await withDb((db) => db.collection("settings").findOne({ organisation: ACME.organisation, sso: { $exists: true } }))).toBeNull();
  });
});
