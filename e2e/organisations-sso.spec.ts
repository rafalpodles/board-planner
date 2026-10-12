import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { OIDC_STUB_URL, ORGANISATIONS_RELAY_ORIGIN, RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { E2E_MONGODB_URI } from "./seed";
import { ACME, GLOBEX, ORGANISATIONS_API, SHARED_KEY, SSO_CLIENT, SSO_LABEL, USERNAME, asOrganisation, makePro, originOf, seedTwoOrganisations, signInOn, storeSso, type OrganisationFixture } from "./organisations";
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
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Continue with Acme/ })).toHaveCount(0);
  });

  test("another organisation is not offered it and cannot start a sign-in through it", async ({ page, request }) => {
    await makePro(request, ACME);
    await makePro(request, GLOBEX);
    await storeSso(ACME);

    await openLogin(page, GLOBEX);
    // The operator's GitHub app is everybody's: waiting for its button is what says the list was drawn, so an absence below is a measurement
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
    await expect(page.getByRole("button", { name: `Continue with ${SSO_LABEL}` })).toHaveCount(0);
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
    // The operator's GitHub app is everybody's: waiting for its button is what says the list was drawn, so an absence below is a measurement
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
    await expect(page.getByRole("button", { name: `Continue with ${SSO_LABEL}` })).toHaveCount(0);

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
    // The page an MCP client sends a person to is a password form of its own, and is closed too (BP-1031)
    const authorizeOn = async (who: OrganisationFixture) => {
      const registered = await request.post(`${ORGANISATIONS_API}/oauth/register`, {
        headers: { ...asOrganisation(who), origin: originOf(who) },
        data: { client_name: "E2E MCP Client", redirect_uris: ["https://client.example/callback"] },
      });
      expect(registered.status(), await registered.text()).toBe(201);
      const fields = {
        client_id: (await registered.json()).client_id as string,
        redirect_uri: "https://client.example/callback",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        response_type: "code",
        scope: "mcp",
        state: "s",
      };
      const form = await request.get(`${ORGANISATIONS_API}/oauth/authorize?${new URLSearchParams(fields)}`, { headers: asOrganisation(who) });
      const posted = await request.post(`${ORGANISATIONS_API}/oauth/authorize`, {
        headers: { ...asOrganisation(who), origin: originOf(who), "sec-fetch-site": "same-origin" },
        form: { phase: "login", ...fields, username: USERNAME, password: who.password },
        maxRedirects: 0,
      });
      return { form: await form.text(), posted };
    };
    const closed = await authorizeOn(ACME);
    expect(closed.form).toContain("Sign in to continue");
    expect(closed.form).not.toContain('type="password"');
    // A correct password posted to it starts no session: no redirect to the consent, no cookie
    expect(closed.posted.status()).toBe(200);
    expect(closed.posted.headers()["set-cookie"] ?? "").not.toContain("cps_");
    expect(await closed.posted.text()).toContain("Sign in to continue");
    // The control: the organisation that does not require it still asks for the password
    const open = await authorizeOn(GLOBEX);
    expect(open.form).toContain('type="password"');
    expect(open.posted.status()).toBe(303);

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

const addMember = (who: OrganisationFixture, role: "member" | "admin") =>
  withDb(async (db) => {
    const email = `ada-${Date.now()}@${who.slug}.example`;
    const _id = new mongoose.Types.ObjectId();
    await db.collection("users").insertOne({
      _id,
      organisation: who.organisation,
      username: `ada${Date.now()}`,
      fullName: "Ada",
      email,
      emailVerifiedAt: new Date(),
      emailNotifications: false,
      collapseEmptyColumns: false,
      kind: "human",
      role,
      createdAt: new Date(),
    });
    return { _id, email };
  });
const roleOf = (id: mongoose.Types.ObjectId) => withDb(async (db) => (await db.collection("users").findOne({ _id: id }))?.role);

async function signInThrough(browser: import("@playwright/test").Browser, who: OrganisationFixture, email: string, groups?: string[], claims: Record<string, unknown> = {}) {
  await script({ sub: `sub-${Date.now()}-${Math.random()}`, email, email_verified: true, ...(groups ? { groups } : {}), ...claims });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${originOf(who)}/login`);
  await page.getByRole("button", { name: `Continue with ${SSO_LABEL}` }).click();
  await expect(page).toHaveURL(`${originOf(who)}/projects`);
  await context.close();
}


test.describe("BP-951: an organisation's admin group", () => {
  test("an administrator sets it on the page; people in the group become administrators at sign-in and the others members", async ({ page, browser, request }) => {
    await makePro(request, ACME);
    await storeSso(ACME);
    const member = await addMember(ACME, "member");
    const admin = await addMember(ACME, "admin");
    await openSettings(page, ACME);

    await page.getByLabel("Admin group (optional)").fill("acme-admins");
    await expect(page.getByTestId("sso-admin-group-note")).toContainText("everybody else a member");
    const saved = page.waitForResponse((response) => response.url().endsWith("/api/settings/sso") && response.request().method() === "PUT");
    await page.getByRole("button", { name: "Save changes" }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByLabel("Admin group (optional)")).toHaveValue("acme-admins");
    await page.screenshot({ path: "e2e/.artifacts/bp951-admin-group.png" });

    await signInThrough(browser, ACME, member.email, ["staff", "acme-admins"]);
    expect(await roleOf(member._id)).toBe("admin");

    await signInThrough(browser, ACME, admin.email, ["staff"]);
    expect(await roleOf(admin._id)).toBe("member");
    const audit = await withDb((db) => db.collection("instanceauditlogs").find({ organisation: ACME.organisation, action: "user_role_changed" }).toArray());
    expect(audit.map((row) => row.detail).join(" ")).toContain("acme-admins");
  });

  test("a different groups claim is read when the organisation names one", async ({ browser, request }) => {
    await makePro(request, ACME);
    await storeSso(ACME, SSO_LABEL, false, { adminGroup: "acme-admins", groupsClaim: "roles" });
    const member = await addMember(ACME, "member");

    await signInThrough(browser, ACME, member.email, ["acme-admins"]);
    expect(await roleOf(member._id), "the groups claim is not the one named").toBe("member");

    await signInThrough(browser, ACME, member.email, undefined, { roles: ["acme-admins"] });
    expect(await roleOf(member._id)).toBe("admin");
  });

  test("it never demotes the last administrator, and is not read for another organisation", async ({ browser, request }) => {
    await makePro(request, ACME);
    await makePro(request, GLOBEX);
    await storeSso(ACME, SSO_LABEL, false, { adminGroup: "acme-admins" });
    await storeSso(GLOBEX);
    await confirmAddress(ACME);

    await signInThrough(browser, ACME, `boss@${ACME.slug}.example`, ["staff"]);
    expect(await roleOf(ACME.adminId), "the last administrator stays").toBe("admin");

    const stranger = await addMember(GLOBEX, "member");
    await signInThrough(browser, GLOBEX, stranger.email, ["acme-admins"]);
    expect(await roleOf(stranger._id)).toBe("member");
  });
});

test.describe("BP-862: roles from identity provider groups", () => {
  const grantOf = (who: OrganisationFixture, user: mongoose.Types.ObjectId) =>
    withDb((db) => db.collection("grants").findOne({ organisation: who.organisation, subject: user, object: who.projectId }));
  const mapGroups = (who: OrganisationFixture, map: { group: string; role: string }[]) =>
    withDb((db) => db.collection("projects").updateOne({ _id: who.projectId }, { $set: { groupRoleMap: map } }));

  test("an owner maps a group on the board's settings, and people get and lose the role at sign-in", async ({ page, browser, request }) => {
    await makePro(request, ACME);
    await storeSso(ACME);
    const ada = await addMember(ACME, "member");
    await signInOn(page.context(), ACME);
    await page.goto(`${originOf(ACME)}/projects/${SHARED_KEY}/settings`);

    await page.getByRole("button", { name: "Add a group" }).click();
    await page.getByLabel("Group", { exact: true }).fill("staff");
    const saved = page.waitForResponse((response) => response.url().endsWith("/group-roles") && response.request().method() === "PUT");
    await page.getByRole("button", { name: "Save group mapping" }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByText("Group mapping saved")).toBeVisible();
    await page.getByRole("heading", { name: "Roles from identity provider groups" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "e2e/.artifacts/bp862-group-mapping.png" });
    expect((await withDb((db) => db.collection("projects").findOne({ _id: ACME.projectId })))?.groupRoleMap).toEqual([{ group: "staff", role: "member" }]);

    await signInThrough(browser, ACME, ada.email, ["staff", "other"]);
    expect(await grantOf(ACME, ada._id)).toMatchObject({ relation: "member", source: "idp" });
    const audit = await withDb((db) => db.collection("projectauditlogs").find({ project: ACME.projectId, action: "member_added" }).toArray());
    expect(audit.map((row) => row.detail).join(" ")).toContain("by the identity provider's group mapping");

    await signInThrough(browser, ACME, ada.email, ["other"]);
    expect(await grantOf(ACME, ada._id), "leaving the group takes the role away").toBeNull();
  });

  test("a token without the groups claim changes nothing, and a role set by hand is never touched", async ({ browser, request }) => {
    await makePro(request, ACME);
    await storeSso(ACME);
    await mapGroups(ACME, [{ group: "staff", role: "member" }]);
    const ada = await addMember(ACME, "member");
    const bo = await addMember(ACME, "member");

    await signInThrough(browser, ACME, ada.email, ["staff"]);
    await signInThrough(browser, ACME, ada.email);
    expect(await grantOf(ACME, ada._id), "no claim says nothing").toMatchObject({ source: "idp" });

    await withDb((db) => db.collection("grants").insertOne({ organisation: ACME.organisation, subject: bo._id, objectType: "project", object: ACME.projectId, relation: "owner", source: "manual", createdAt: new Date(), updatedAt: new Date() }));
    await signInThrough(browser, ACME, bo.email, ["other"]);
    expect(await grantOf(ACME, bo._id), "a manual grant stays").toMatchObject({ relation: "owner", source: "manual" });
  });

  test("the last owner is never removed or demoted by the mapping, and the highest role of several groups wins", async ({ browser, request }) => {
    await makePro(request, ACME);
    await storeSso(ACME);
    await mapGroups(ACME, [{ group: "staff", role: "member" }, { group: "leads", role: "owner" }]);
    const ada = await addMember(ACME, "member");

    await signInThrough(browser, ACME, ada.email, ["staff", "leads"]);
    expect(await grantOf(ACME, ada._id)).toMatchObject({ relation: "owner", source: "idp" });

    await signInThrough(browser, ACME, ada.email, ["other"]);
    expect(await grantOf(ACME, ada._id), "the only owner stays").toMatchObject({ relation: "owner", source: "idp" });

    await withDb((db) => db.collection("grants").insertOne({ organisation: ACME.organisation, subject: ACME.adminId, objectType: "project", object: ACME.projectId, relation: "owner", source: "manual", createdAt: new Date(), updatedAt: new Date() }));
    await signInThrough(browser, ACME, ada.email, ["staff"]);
    expect(await grantOf(ACME, ada._id), "with another owner it steps down to the group's role").toMatchObject({ relation: "member", source: "idp" });
  });

  test("the mapping is part of Pro: refused on Free with the 402", async ({ page }) => {
    await signInOn(page.context(), GLOBEX);
    await page.goto(`${originOf(GLOBEX)}/projects/${SHARED_KEY}/settings`);
    const refused = await page.evaluate(async (project) => {
      const res = await fetch(`/api/projects/${project}/group-roles`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ map: [{ group: "staff", role: "member" }] }) });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }, String(GLOBEX.projectId));
    expect(refused.status).toBe(402);
    expect(refused.body).toMatchObject({ feature: "identity.sso" });
  });
});
