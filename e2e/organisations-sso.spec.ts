import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { OIDC_STUB_URL, ORGANISATIONS_RELAY_ORIGIN, RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { E2E_MONGODB_URI } from "./seed";
import { ACME, GLOBEX, ORGANISATIONS_API, SSO_CLIENT, SSO_LABEL, USERNAME, asOrganisation, makePro, originOf, seedTwoOrganisations, signInOn, storeSso, type OrganisationFixture } from "./organisations";
import { freshAddress, giveAddress, provideAddressAndCode, apiCode } from "./platform-sign-in";

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
async function putFrom(page: Page, body: Record<string, unknown>) {
  return page.evaluate(
    async (data) => {
      const res = await fetch("/api/settings/sso", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    { ...body }
  );
}

// What a sign-in page offers is read from the server after it loads: an absence is only worth asserting once that answer is in
async function openLogin(page: Page, who: OrganisationFixture) {
  const answered = page.waitForResponse((response) => response.url().includes("/api/auth/oidc/providers"));
  await page.goto(`${originOf(who)}/login`);
  await answered;
}

async function openSettings(page: Page, who: OrganisationFixture) {
  await signInOn(page.context(), who);
  await page.goto(`${originOf(who)}/settings/sso`);
  await expect(page.getByRole("heading", { name: "Single sign-on", exact: true })).toBeVisible();
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
    await expect(page.getByText("Active", { exact: true })).toBeVisible();
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
    const visitorContext = await browser.newContext();
    const visitor = await visitorContext.newPage();
    await visitor.goto(`${originOf(ACME)}/login`);
    await visitor.getByRole("button", { name: `Continue with ${SSO_LABEL}` }).click();
    await expect(visitor).toHaveURL(`${originOf(ACME)}/projects`);
    await visitorContext.close();

    // A save that leaves the secret blank keeps the stored one: the new name is offered and sign-in still works
    await page.getByLabel("Button name").fill("Acme SSO");
    const saved = page.waitForResponse((response) => response.url().endsWith("/api/settings/sso") && response.request().method() === "PUT");
    await page.getByRole("button", { name: "Save changes" }).click();
    expect((await saved).status()).toBe(200);
    const again = await browser.newContext();
    const second = await again.newPage();
    await script({ sub: `sub-acme-${Date.now()}-b`, email: `boss@${ACME.slug}.example`, email_verified: true });
    await second.goto(`${originOf(ACME)}/login`);
    await second.getByRole("button", { name: "Continue with Acme SSO" }).click();
    await expect(second).toHaveURL(`${originOf(ACME)}/projects`);
    await again.close();

    // Removing it takes the button away, after a confirmation
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByText("Sign-in provider removed")).toBeVisible();
    await expect(page.getByText("Not set up")).toBeVisible();
    await openLogin(page, ACME);
    await expect(page.getByRole("button", { name: /^Continue with Acme/ })).toHaveCount(0);
  });

  test("another organisation is not offered it and cannot start a sign-in through it", async ({ page, request }) => {
    await makePro(request, ACME);
    await makePro(request, GLOBEX);
    await storeSso(ACME);

    await openLogin(page, GLOBEX);
    await expect(page.getByRole("button", { name: /^Continue with/ })).toHaveCount(0);
    // The operator's GitHub app is everybody's; ACME's own provider is nobody else's
    expect(await (await page.request.get(`${originOf(GLOBEX)}/api/auth/oidc/providers`)).json()).not.toContainEqual(expect.objectContaining({ id: "oidc" }));
    const started = await page.evaluate(async () => {
      const res = await fetch("/api/auth/oidc/oidc/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    });
    expect(started.status).toBe(404);
    expect(started.body.error).toContain("not set up here");

    await openLogin(page, ACME);
    await expect(page.getByRole("button", { name: `Continue with ${SSO_LABEL}` })).toBeVisible();
    expect(await (await page.request.get(`${originOf(ACME)}/api/auth/oidc/providers`)).json()).toContainEqual({ id: "oidc", label: SSO_LABEL });
  });

  test("a Free organisation is told it is part of Pro and the trial, and the server refuses it with a 402", async ({ page }) => {
    await openSettings(page, GLOBEX);

    await expect(page.getByTestId("sso-upgrade")).toContainText("included in Pro and in the trial");
    await expect(page.getByTestId("sso-form")).toHaveCount(0);
    const refused = await putFrom(page, { issuer: OIDC_STUB_URL, clientId: SSO_CLIENT.clientId, clientSecret: SSO_CLIENT.clientSecret });
    expect(refused.status).toBe(402);
    expect(refused.body).toMatchObject({ feature: "identity.sso", plan: "free" });
    expect(await withDb((db) => db.collection("settings").findOne({ organisation: GLOBEX.organisation, sso: { $exists: true } }))).toBeNull();
    await page.screenshot({ path: "e2e/.artifacts/bp951-free.png" });
  });

  test("what was stored stays while the plan does not include it, and is offered again with the plan", async ({ page, request }) => {
    await storeSso(GLOBEX);

    await openLogin(page, GLOBEX);
    await expect(page.getByRole("button", { name: /^Continue with/ })).toHaveCount(0);

    await makePro(request, GLOBEX);
    await page.goto(`${originOf(GLOBEX)}/login`);
    await expect(page.getByRole("button", { name: `Continue with ${SSO_LABEL}` })).toBeVisible();
  });

  test("refuses an address inside the network, and a provider that does not answer", async ({ page, request }) => {
    await makePro(request, ACME);
    await openSettings(page, ACME);

    const inside = await putFrom(page, { issuer: "https://10.0.0.1", clientId: SSO_CLIENT.clientId, clientSecret: SSO_CLIENT.clientSecret });
    expect(inside.status).toBe(400);
    expect(inside.body.error).toContain("not one this server may call");

    const silent = await putFrom(page, { issuer: "https://127.0.0.1:9", clientId: SSO_CLIENT.clientId, clientSecret: SSO_CLIENT.clientSecret });
    expect(silent.status).toBe(400);
    expect(await withDb((db) => db.collection("settings").findOne({ organisation: ACME.organisation, sso: { $exists: true } }))).toBeNull();
  });
});

test.describe("BP-951: requiring single sign-on", () => {
  const passwordLogin = (request: import("@playwright/test").APIRequestContext, who: OrganisationFixture) =>
    request.post(`${ORGANISATIONS_API}/api/auth/login`, { headers: { ...asOrganisation(who), origin: originOf(who) }, data: { username: USERNAME, password: who.password } });

  test("an administrator turns it on, with the warning in front of them, and the login page offers the provider alone", async ({ page, browser, request }) => {
    await makePro(request, ACME);
    await storeSso(ACME);
    await openSettings(page, ACME);

    await expect(page.getByTestId("sso-enforce-warning")).toContainText("nobody can sign in");
    await page.getByRole("button", { name: "Require single sign-on" }).click();
    await expect(page.getByText("Single sign-on is now required")).toBeVisible();
    await expect(page.getByText("Required", { exact: true })).toBeVisible();
    await page.screenshot({ path: "e2e/.artifacts/bp951-enforce-on.png" });
    expect((await withDb((db) => db.collection("settings").findOne({ organisation: ACME.organisation })))?.sso.enforced).toBe(true);

    const visitorContext = await browser.newContext();
    const visitor = await visitorContext.newPage();
    await openLogin(visitor, ACME);
    await expect(visitor.getByRole("button", { name: `Continue with ${SSO_LABEL}` })).toBeVisible();
    await expect(visitor.getByRole("button", { name: /^Continue with (Google|GitHub)/ })).toHaveCount(0);
    await expect(visitor.getByLabel("Password")).toHaveCount(0);
    await visitor.screenshot({ path: "e2e/.artifacts/bp951-enforced-login.png" });

    await confirmAddress(ACME);
    await script({ sub: `sub-enforced-${Date.now()}`, email: `boss@${ACME.slug}.example`, email_verified: true });
    await visitor.getByRole("button", { name: `Continue with ${SSO_LABEL}` }).click();
    await expect(visitor).toHaveURL(`${originOf(ACME)}/projects`);
    await visitorContext.close();
  });

  test("every other way in is refused for that organisation and stays open for the others", async ({ request }) => {
    await makePro(request, ACME);
    await makePro(request, GLOBEX);
    await storeSso(ACME, SSO_LABEL, true);
    await storeSso(GLOBEX);

    const refused = await passwordLogin(request, ACME);
    expect(refused.status()).toBe(403);
    expect(await refused.json()).toMatchObject({ ssoRequired: true });
    expect((await request.post(`${ORGANISATIONS_API}/api/auth/forgot`, { headers: { ...asOrganisation(ACME), origin: originOf(ACME) }, data: { identifier: USERNAME } })).status()).toBe(403);
    // A link already in somebody's mailbox does not set a password either
    for (const path of ["reset", "../invitations/accept"]) {
      const closed = await request.post(`${ORGANISATIONS_API}/api/auth/${path}`, { headers: { ...asOrganisation(ACME), origin: originOf(ACME) }, data: { token: "not-a-real-token", newPassword: "long-enough-password", username: "x", fullName: "X", password: "long-enough-password" } });
      expect(closed.status(), path).toBe(403);
      expect(await closed.json()).toMatchObject({ ssoRequired: true });
    }
    expect(await (await request.get(`${ORGANISATIONS_API}/api/auth/oidc/providers`, { headers: asOrganisation(ACME) })).json()).toEqual([{ id: "oidc", label: SSO_LABEL }]);
    expect((await request.get(`${ORGANISATIONS_API}/api/auth/instance`, { headers: asOrganisation(ACME) })).status()).toBe(200);
    expect((await (await request.get(`${ORGANISATIONS_API}/api/auth/instance`, { headers: asOrganisation(ACME) })).json()).passwordSignIn).toBe(false);

    const github = await request.post(`${ORGANISATIONS_API}/api/auth/oidc/github/start`, { headers: { ...asOrganisation(ACME), origin: originOf(ACME) }, data: {} });
    expect(github.status()).toBe(404);

    expect((await passwordLogin(request, GLOBEX)).status()).toBe(200);
    expect((await (await request.get(`${ORGANISATIONS_API}/api/auth/oidc/providers`, { headers: asOrganisation(GLOBEX) })).json()).map((p: { id: string }) => p.id)).toContain("github");
  });

  test("on the platform host the organisation is a link to its own page, and a password is refused", async ({ page, request }) => {
    await makePro(request, ACME);
    await storeSso(ACME, SSO_LABEL, true);
    const email = freshAddress("sso");
    await giveAddress(ACME, email);

    const signedIn = await apiCode(request, email);
    const verified = await request.post(`${ORGANISATIONS_API}/api/sign-in/password`, { headers: signedIn, data: { organisation: String(ACME.organisation), password: ACME.password } });
    expect(verified.status()).toBe(403);
    expect(await verified.json()).toMatchObject({ ssoRequired: true });

    await provideAddressAndCode(page, email);
    await expect(page.getByText("signs in through its own page")).toBeVisible();
    await expect(page.getByLabel("Password")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^Continue on / })).toHaveAttribute("href", `${originOf(ACME)}/login`);
    await page.screenshot({ path: "e2e/.artifacts/bp951-enforced-platform.png" });
  });

  test("it is off where the plan no longer offers the provider, and back with the plan", async ({ request }) => {
    await storeSso(ACME, SSO_LABEL, true);

    expect((await passwordLogin(request, ACME)).status()).toBe(200);

    await makePro(request, ACME);
    expect((await passwordLogin(request, ACME)).status()).toBe(403);
  });

  test("stopping it opens the other ways in again", async ({ page, request }) => {
    await makePro(request, ACME);
    await storeSso(ACME, SSO_LABEL, true);
    await openSettings(page, ACME);

    await page.getByRole("button", { name: "Stop requiring single sign-on" }).click();
    await expect(page.getByText("Single sign-on is no longer required")).toBeVisible();

    expect((await passwordLogin(request, ACME)).status()).toBe(200);
  });
});
