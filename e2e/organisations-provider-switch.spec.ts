import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { GITHUB_STUB_URL, RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { E2E_MONGODB_URI } from "./seed";
import { ACME, GLOBEX, makePro, originOf, seedTwoOrganisations, signInOn, storeSso, type OrganisationFixture } from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

/**
 * BP-1027. Google and GitHub are the operator's, so every organisation is offered both. An administrator switches either
 * off for their organisation on Settings → Single sign-on: the button goes, the server refuses it, nothing already
 * stored is touched. This server has the operator's GitHub only, so GitHub is the provider driven here; Google goes
 * through the same code and is covered by the unit tests.
 */

async function withDb<T>(work: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await work(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

const GITHUB_ONLY = new mongoose.Types.ObjectId("e2e0000000000000000ac0f1");

// A member whose only way in is GitHub: no password, and a link to the operator's GitHub
const linkMemberToGitHub = () =>
  withDb(async (db) => {
    await db.collection("users").insertOne({
      _id: GITHUB_ONLY,
      organisation: ACME.organisation,
      username: "ghonly",
      fullName: "GitHub Only",
      email: "ghonly@acme.example",
      role: "member",
      createdAt: new Date(),
    });
    await db.collection("identities").insertOne({
      organisation: ACME.organisation,
      user: GITHUB_ONLY,
      provider: "github",
      issuer: GITHUB_STUB_URL,
      subject: "gh-only-1",
      email: "ghonly@acme.example",
      linkedAt: new Date(),
    });
  });

const disabled = (who: OrganisationFixture) => withDb(async (db) => (await db.collection("settings").findOne({ organisation: who.organisation }))?.disabledProviders ?? []);

// What a sign-in page offers is read from the server after it loads: an absence is only worth asserting once that answer is in
async function openLogin(page: Page, who: OrganisationFixture) {
  const answered = page.waitForResponse((response) => response.url().includes("/api/auth/oidc/providers"));
  await page.goto(`${originOf(who)}/login`);
  await answered;
}

// An absence on a page that fetches what it shows is true before it has rendered: ask the server what it offers, then let the page settle
async function expectNoGitHub(page: Page, who: OrganisationFixture) {
  expect(await (await page.request.get(`${originOf(who)}/api/auth/oidc/providers`)).json()).not.toContainEqual(expect.objectContaining({ id: "github" }));
  await expect(page.getByRole("button", { name: "Sign In", exact: true })).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toHaveCount(0);
}

async function openSettings(page: Page) {
  await signInOn(page.context(), ACME);
  await page.goto(`${originOf(ACME)}/settings/sso`);
  await expect(page.getByTestId("sign-in-providers")).toBeVisible();
}

const switchSaved = (page: Page) => page.waitForResponse((response) => response.url().endsWith("/api/settings/sign-in-providers") && response.request().method() === "PUT");
const github = (page: Page) => page.getByTestId("sign-in-providers").getByRole("switch", { name: /^Sign in with GitHub/ });
// The input is visually hidden: a person clicks its label
const clickGitHub = (page: Page) => page.getByTestId("sign-in-providers").getByText("Sign in with GitHub", { exact: true }).click();

test.beforeEach(async () => {
  await seedTwoOrganisations();
});

test.describe("BP-1027: switching GitHub off for an organisation", () => {
  test("the button goes, the server refuses it, another organisation keeps it, and it comes back", async ({ page, browser }) => {
    await openSettings(page);
    await expect(github(page)).toBeChecked();
    await page.screenshot({ path: "e2e/.artifacts/bp1027-settings.png" });

    const visitorContext = await browser.newContext();
    const visitor = await visitorContext.newPage();
    await openLogin(visitor, ACME);
    await expect(visitor.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();

    const off = switchSaved(page);
    await clickGitHub(page);
    expect((await off).status()).toBe(200);
    await expect(page.getByText("Sign-in with GitHub turned off")).toBeVisible();
    await expect(github(page)).not.toBeChecked();
    expect(await disabled(ACME)).toEqual(["github"]);

    await openLogin(visitor, ACME);
    await expectNoGitHub(visitor, ACME);
    const started = await visitor.evaluate(async () => {
      const res = await fetch("/api/auth/oidc/github/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    });
    expect(started.status).toBe(404);
    expect(started.body.error).toBe("That sign-in is turned off for this organisation");

    // A browser that was already on its way back from GitHub is sent to the page that says why
    await visitor.goto(`${originOf(ACME)}/api/auth/oidc/github/callback?code=c&state=s`);
    await expect(visitor).toHaveURL(`${originOf(ACME)}/login?sso=provider_off`);
    await expect(visitor.getByText("Signing in with that provider is turned off for this organisation.")).toBeVisible();

    // What is open stays open, and the other organisation is not touched
    expect(await page.evaluate(async () => (await fetch("/api/auth/me")).status)).toBe(200);
    await openLogin(visitor, GLOBEX);
    await expect(visitor.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();

    const on = switchSaved(page);
    await clickGitHub(page);
    expect((await on).status()).toBe(200);
    await expect(github(page)).toBeChecked();
    expect(await disabled(ACME)).toEqual([]);
    await openLogin(visitor, ACME);
    await expect(visitor.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
    expect(
      await visitor.evaluate(async () => {
        const res = await fetch("/api/auth/oidc/github/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        return { status: res.status, hasUrl: typeof (await res.json().catch(() => ({}))).url === "string" };
      })
    ).toEqual({ status: 200, hasUrl: true });
    await visitorContext.close();
  });

  test("asks first when a member could only sign in through it, and leaves their link alone", async ({ page, browser }) => {
    await linkMemberToGitHub();
    await openSettings(page);

    await clickGitHub(page);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("1 member signs in only through GitHub");
    await page.screenshot({ path: "e2e/.artifacts/bp1027-warning.png" });

    // Declined: it stays on, and still offered
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(github(page)).toBeChecked();
    expect(await disabled(ACME)).toEqual([]);
    const visitorContext = await browser.newContext();
    const visitor = await visitorContext.newPage();
    await openLogin(visitor, ACME);
    await expect(visitor.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();

    // Confirmed: it goes, and the member's link is still stored for the day it comes back
    await clickGitHub(page);
    await expect(page.getByRole("dialog")).toContainText("1 member signs in only through GitHub");
    const off = switchSaved(page);
    await page.getByRole("dialog").getByRole("button", { name: "Turn off" }).click();
    expect((await off).status()).toBe(200);
    await expect(github(page)).not.toBeChecked();
    expect(await disabled(ACME)).toEqual(["github"]);
    expect(await withDb((db) => db.collection("identities").countDocuments({ user: GITHUB_ONLY, provider: "github" }))).toBe(1);
    await openLogin(visitor, ACME);
    await expectNoGitHub(visitor, ACME);
    await visitorContext.close();
  });

  test("an organisation that requires its own single sign-on is told Google and GitHub are closed anyway", async ({ page, request }) => {
    await makePro(request, ACME);
    await storeSso(ACME, "Acme login", true);

    await openSettings(page);

    await expect(page.getByTestId("sign-in-providers-enforced")).toContainText("Single sign-on is required");
  });
});
