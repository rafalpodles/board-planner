import { test, expect, type APIRequestContext } from "@playwright/test";
import { createHash, randomBytes } from "crypto";
import { RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { ACME, ORGANISATIONS_API, asOrganisation, bearer, originOf, seedTwoOrganisations, signInOn } from "./organisations";
import { apiCode, freshAddress, provideAddressAndCode, withDb } from "./platform-sign-in";
import { pkce } from "./mcp";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

const VERSION = "2026-10-15";
const NEXT_VERSION = "2026-12-01";
const REFUSAL = "Accept the Terms of Service and the Privacy Policy to create an account.";
const PASSWORD = "initech-password-1";
const SHOTS = "e2e/.artifacts";

const publish = async (request: APIRequestContext, version: string | undefined) =>
  expect((await request.post(`${ORGANISATIONS_API}/api/e2e/legal-terms`, { data: { version } })).status()).toBe(204);

async function invite(email: string) {
  const token = `cpi_${randomBytes(32).toString("hex")}`;
  await withDb((db) =>
    db.collection("invitations").insertOne({
      organisation: ACME.organisation,
      email,
      role: "member",
      boards: [],
      invitedBy: ACME.adminId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      status: "pending",
      acceptedBy: null,
      acceptedAt: null,
      deliveredAs: "email",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  );
  return token;
}

test.beforeEach(async ({ request }) => {
  await seedTwoOrganisations();
  await publish(request, VERSION);
});

test.afterAll(async ({ request }) => {
  await publish(request, undefined);
});

test.describe("BP-939: the cloud terms", () => {
  test("creating an organisation asks for an unticked box, the server refuses without it, and the acceptance is stored and shown", async ({ page, request }) => {
    const refusedEmail = freshAddress("refused");
    const refused = await request.post(`${ORGANISATIONS_API}/api/sign-in/organisation`, {
      headers: await apiCode(request, refusedEmail),
      data: { name: "No Terms", slug: `no-terms-${Date.now()}`, fullName: "Owner", username: "owner", password: PASSWORD },
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error).toBe(REFUSAL);
    expect(await withDb((db) => db.collection("organisations").countDocuments({ name: "No Terms" }))).toBe(0);

    const email = freshAddress("bill");
    await provideAddressAndCode(page, email);
    await page.getByRole("button", { name: "Create an organisation" }).click();
    await page.getByLabel("Organisation name").fill("Initech Terms");
    await page.getByLabel("Your name").fill("Bill Lumbergh");
    await page.getByLabel("Password").fill(PASSWORD);

    const box = page.getByTestId("accept-terms").getByRole("checkbox");
    await expect(box).not.toBeChecked();
    await expect(page.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "https://board-planner.com/legal/terms");
    await expect(page.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "https://board-planner.com/legal/privacy");
    await expect(page.getByRole("link", { name: "Polski" })).toHaveCount(2);
    await page.screenshot({ path: `${SHOTS}/bp939-sign-up.png`, fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: `${SHOTS}/bp939-sign-up-phone.png`, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.getByRole("button", { name: "Create the organisation" }).click();
    expect(await box.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
    await expect(page.getByTestId("create-organisation")).toBeVisible();

    await box.check();
    const created = page.waitForResponse((r) => r.url().endsWith("/api/sign-in/organisation"));
    await page.getByRole("button", { name: "Create the organisation" }).click();
    expect((await created).status()).toBe(201);
    await page.waitForURL(`${originOf("initech-terms")}/projects`);

    const [organisation, admin] = await withDb(async (db) => {
      const row = await db.collection("organisations").findOne({ slug: "initech-terms" });
      return [row, await db.collection("users").findOne({ organisation: row!._id, email })];
    });
    expect(admin).toMatchObject({ termsAcceptedVersion: VERSION });
    expect(admin!.termsAcceptedAt).toBeInstanceOf(Date);
    expect(organisation).toMatchObject({ termsAcceptedVersion: VERSION, termsAcceptedAt: admin!.termsAcceptedAt });
    expect(String(organisation!.termsAcceptedBy)).toBe(String(admin!._id));

    await page.goto(`${originOf("initech-terms")}/settings/organisation`);
    await expect(page.getByTestId("organisation-terms")).toHaveText(new RegExp(`^${VERSION}, accepted .+ by Bill Lumbergh \\(@bill-.+\\) at sign-up$`));
    await page.screenshot({ path: `${SHOTS}/bp939-organisation-settings.png`, fullPage: true });
    await page.goto(`${originOf("initech-terms")}/settings/users`);
    await expect(page.getByTestId("user-terms")).toHaveText(new RegExp(`^Terms ${VERSION} accepted `));
    await page.screenshot({ path: `${SHOTS}/bp939-users.png`, fullPage: true });
  });

  test("accepting an invitation asks for the box, the server refuses without it and keeps the link, and stores the version", async ({ page, request }) => {
    const email = freshAddress("invitee");
    const token = await invite(email);

    const refused = await request.post(`${ORGANISATIONS_API}/api/invitations/accept`, {
      headers: asOrganisation(ACME),
      data: { token, username: "invitee", fullName: "In Vitee", password: "a-long-password" },
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error).toBe(REFUSAL);
    expect(await withDb((db) => db.collection("invitations").findOne({ email }))).toMatchObject({ status: "pending" });

    await page.goto(`${originOf(ACME)}/invite?token=${token}`);
    await page.getByLabel("Username").fill("invitee");
    await page.getByLabel("Full name").fill("In Vitee");
    await page.getByLabel("Password", { exact: true }).fill("a-long-password");
    await page.getByLabel("Confirm password").fill("a-long-password");
    const box = page.getByTestId("accept-terms").getByRole("checkbox");
    await expect(box).not.toBeChecked();
    await box.check();
    const accepted = page.waitForResponse((r) => r.url().endsWith("/api/invitations/accept"));
    await page.getByRole("button", { name: "Create my account" }).click();
    expect((await accepted).status()).toBe(201);
    await page.waitForURL(/\/projects/);

    const user = await withDb((db) => db.collection("users").findOne({ organisation: ACME.organisation, email }));
    expect(user).toMatchObject({ username: "invitee", termsAcceptedVersion: VERSION });
    expect(user!.termsAcceptedAt).toBeInstanceOf(Date);
  });

  test("a new version leaves the app usable, tells the person once in a banner they can dismiss, and records it as seen, not accepted", async ({ page, request }) => {
    await withDb((db) =>
      db.collection("users").updateOne({ _id: ACME.adminId }, { $set: { termsAcceptedVersion: VERSION, termsAcceptedAt: new Date("2026-01-02") } })
    );
    await signInOn(page.context(), ACME);
    await page.goto(`${originOf(ACME)}/projects`);
    await expect(page.getByRole("button", { name: /Account menu/ })).toBeVisible();
    await expect(page.getByTestId("terms-changed")).toHaveCount(0);

    await publish(request, NEXT_VERSION);
    await page.goto(`${originOf(ACME)}/projects`);
    const banner = page.getByTestId("terms-changed");
    await expect(banner.getByTestId("terms-changed-message")).toContainText("The Terms of Service and Privacy Policy changed on");
    await expect(banner.getByRole("link", { name: "Read them" })).toHaveAttribute("href", "https://board-planner.com/legal/terms");
    await expect(banner.getByRole("link", { name: "Polski" })).toHaveAttribute("href", "https://board-planner.com/legal/terms/pl");
    await expect(page.getByRole("button", { name: /Account menu/ })).toBeVisible();
    await page.getByRole("link", { name: ACME.projectName }).first().click();
    await expect(page).toHaveURL(/\/projects\/[^/]+/);
    const board = page.locator("#main-content").getByText(ACME.projectName).first();
    await expect(board).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/bp939-banner.png` });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await expect(banner).toBeVisible();
    await expect(board).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/bp939-banner-phone.png` });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.reload();
    await expect(banner).toBeVisible();

    const asMachine = await request.get(`${ORGANISATIONS_API}/api/projects`, { headers: asOrganisation(ACME, bearer(ACME)) });
    expect(asMachine.status()).toBe(200);
    const machineMe = await request.get(`${ORGANISATIONS_API}/api/auth/me`, { headers: asOrganisation(ACME, bearer(ACME)) });
    expect(machineMe.status()).toBe(200);

    const clickedAt = Date.now();
    const recorded = page.waitForResponse((r) => r.url().endsWith("/api/users/me/terms"));
    await banner.getByRole("button", { name: "Dismiss the notice of the terms" }).click();
    expect((await recorded).status()).toBe(200);
    await expect(banner).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole("button", { name: /Account menu/ })).toBeVisible();
    await page.waitForTimeout(1_000);
    await expect(page.getByTestId("terms-changed")).toHaveCount(0);

    const admin = await withDb((db) => db.collection("users").findOne({ _id: ACME.adminId }));
    expect(admin).toMatchObject({ termsAcceptedVersion: VERSION, termsNotifiedVersion: NEXT_VERSION });
    expect(admin!.termsNotifiedAt.getTime()).toBeGreaterThanOrEqual(clickedAt - 1_000);
    expect(await withDb((db) => db.collection("instanceauditlogs").countDocuments({ organisation: ACME.organisation, action: "terms_change_seen" }))).toBe(1);
  });

  test("a member an admin made, who never ticked a box, is told the terms apply to their use, not that they changed", async ({ page, browser }) => {
    await signInOn(page.context(), ACME);
    const created = await page.request.post(`${originOf(ACME)}/api/users`, {
      headers: { origin: originOf(ACME), "sec-fetch-site": "same-origin" },
      data: { username: "made-by-admin", fullName: "Made By Admin", email: freshAddress("made"), password: "a-long-password" },
    });
    expect(created.status(), await created.text()).toBe(201);
    expect(await withDb((db) => db.collection("users").findOne({ organisation: ACME.organisation, username: "made-by-admin" }))).not.toHaveProperty(
      "termsAcceptedVersion"
    );

    const theirs = await browser.newContext();
    const member = await theirs.newPage();
    await member.goto(`${originOf(ACME)}/login`);
    await member.getByLabel("Username").fill("made-by-admin");
    await member.getByLabel("Password").fill("a-long-password");
    await member.getByRole("button", { name: "Sign In" }).click();
    await expect(member).not.toHaveURL(/\/login/);

    const banner = member.getByTestId("terms-changed");
    await expect(banner.getByTestId("terms-changed-message")).toHaveText(
      "Board Planner's Terms of Service and Privacy Policy apply to your use of it. Read them (Polski)."
    );
    await expect(member.getByRole("button", { name: /Account menu/ })).toBeVisible();
    await member.screenshot({ path: `${SHOTS}/bp939-banner-member.png` });

    const recorded = member.waitForResponse((r) => r.url().endsWith("/api/users/me/terms"));
    await banner.getByRole("button", { name: "Dismiss the notice of the terms" }).click();
    expect((await recorded).status()).toBe(200);
    await expect(banner).toHaveCount(0);
    await member.reload();
    await expect(member.getByRole("button", { name: /Account menu/ })).toBeVisible();
    await member.waitForTimeout(1_000);
    await expect(member.getByTestId("terms-changed")).toHaveCount(0);
    expect(await withDb((db) => db.collection("users").findOne({ organisation: ACME.organisation, username: "made-by-admin" }))).toMatchObject({
      termsNotifiedVersion: VERSION,
    });
    await theirs.close();
  });

  test("connecting an app needs no acceptance of a new version", async ({ page, request }) => {
    const redirectUri = "http://127.0.0.1:9/callback";
    const registration = await request.post(`${ORGANISATIONS_API}/oauth/register`, {
      headers: asOrganisation(ACME),
      data: { client_name: "Terms Client", redirect_uris: [redirectUri] },
    });
    expect(registration.status(), await registration.text()).toBe(201);
    const { client_id: clientId } = await registration.json();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      scope: "mcp",
      state: "terms-state",
    });

    await signInOn(page.context(), ACME);
    const consent = await page.goto(`${originOf(ACME)}/oauth/authorize?${query.toString()}`);
    expect(consent?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Grant access" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Authorize" })).toBeVisible();
    const admin = await withDb((db) => db.collection("users").findOne({ _id: ACME.adminId }));
    expect(admin).not.toHaveProperty("termsAcceptedVersion");
  });
});
