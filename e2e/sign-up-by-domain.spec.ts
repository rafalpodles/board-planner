import { test, expect, type Browser } from "@playwright/test";
import { createHash, randomBytes } from "crypto";
import mongoose from "mongoose";
import { OIDC_STUB_LABEL, OIDC_STUB_URL } from "../playwright.config";
import { ADMIN_ID, E2E_MONGODB_URI, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-833. An administrator lists e-mail domains; somebody the identity provider confirms at one of
 * them, with no account yet, makes their own — a member with no boards. Nobody else does.
 */

const DOMAIN = "signup-e2e.example";

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

const setDomains = async (domains: string[]) =>
  (await db()).collection("settings").updateOne({}, { $set: { signUpDomains: domains } }, { upsert: true });

async function nextPerson(person: { email: string; email_verified?: boolean; name?: string }) {
  const res = await fetch(`${OIDC_STUB_URL}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sub: `sub-${randomBytes(4).toString("hex")}`, email_verified: true, ...person }),
  });
  expect(res.ok, "the OIDC stub refused its script").toBe(true);
}

async function arriveThroughProvider(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: `Continue with ${OIDC_STUB_LABEL}` }).click();
  return { context, page };
}

const accountFor = async (email: string) => (await db()).collection("users").findOne({ email });

test.beforeEach(async () => {
  await seed();
  await setDomains([]);
});

test.afterEach(async () => {
  await setDomains([]);
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("an administrator opens sign-up to a domain, and a newcomer there makes their own account", async ({ page, browser }) => {
  await signIn(page);
  await page.goto("/settings/users");
  await page.getByLabel("Domains").fill(`  ${DOMAIN.toUpperCase()} `);
  await page.getByRole("button", { name: "Save domains" }).click();
  await expect(page.getByLabel("Domains")).toHaveValue(DOMAIN);

  const email = `grace-${randomBytes(3).toString("hex")}@${DOMAIN}`;
  await nextPerson({ email, name: "Grace Hopper" });
  const newcomer = await arriveThroughProvider(browser);
  await expect(newcomer.page).toHaveURL(/\/join\/sso$/);
  await expect(newcomer.page.getByText(`${OIDC_STUB_LABEL} confirmed ${email}.`)).toBeVisible();
  await expect(newcomer.page.getByLabel("Full name")).toHaveValue("Grace Hopper");
  const username = `grace${randomBytes(3).toString("hex")}`;
  await newcomer.page.getByLabel("Username").fill(username);
  await newcomer.page.getByRole("button", { name: "Create my account" }).click();
  await expect(newcomer.page).toHaveURL(/\/projects$/);
  expect((await (await newcomer.page.request.get("/api/auth/me")).json()).username).toBe(username);

  const account = await accountFor(email);
  expect(account).toMatchObject({ username, role: "member" });
  expect(account).not.toHaveProperty("password");
  expect(account?.emailVerifiedAt).toBeInstanceOf(Date);
  expect(await (await db()).collection("grants").countDocuments({ subject: account?._id })).toBe(0);
  await newcomer.context.close();

  await page.reload();
  await expect(page.getByText(`@${username}`, { exact: true })).toBeVisible();
});

test("an address outside the domains, or one the provider has not confirmed, makes no account", async ({ browser }) => {
  await setDomains([DOMAIN]);

  const outsider = `ada-${randomBytes(3).toString("hex")}@elsewhere-e2e.example`;
  await nextPerson({ email: outsider });
  const first = await arriveThroughProvider(browser);
  await expect(first.page).toHaveURL(/sso=no_account/);
  await expect(first.page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText(
    "No account here uses that address."
  );
  await first.context.close();

  const unconfirmed = `ada-${randomBytes(3).toString("hex")}@${DOMAIN}`;
  await nextPerson({ email: unconfirmed, email_verified: false });
  const second = await arriveThroughProvider(browser);
  await expect(second.page).toHaveURL(/sso=unverified/);
  await second.context.close();

  expect(await accountFor(outsider)).toBeNull();
  expect(await accountFor(unconfirmed)).toBeNull();
});

test("a domain closed while the newcomer chooses a username makes no account", async ({ browser }) => {
  await setDomains([DOMAIN]);
  const email = `late-${randomBytes(3).toString("hex")}@${DOMAIN}`;
  await nextPerson({ email, name: "Late Comer" });
  const newcomer = await arriveThroughProvider(browser);
  await expect(newcomer.page).toHaveURL(/\/join\/sso$/);

  await setDomains([]);
  await newcomer.page.getByLabel("Username").fill(`late${randomBytes(3).toString("hex")}`);
  await newcomer.page.getByRole("button", { name: "Create my account" }).click();

  await expect(newcomer.page.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveText(
    "Sign-up is no longer open to that address. Ask an administrator for an invitation."
  );
  expect(await accountFor(email)).toBeNull();
  await newcomer.context.close();
});

test("a newcomer with a pending invitation accepts it, keeping the role it names", async ({ browser }) => {
  await setDomains([DOMAIN]);
  const email = `invited-${randomBytes(3).toString("hex")}@${DOMAIN}`;
  await (await db()).collection("invitations").insertOne({
    email,
    role: "admin",
    boards: [],
    invitedBy: ADMIN_ID,
    tokenHash: createHash("sha256").update(`cpi_${randomBytes(32).toString("hex")}`).digest("hex"),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    status: "pending",
    acceptedBy: null,
    acceptedAt: null,
    deliveredAs: "email",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await nextPerson({ email, name: "Invited Person" });

  const newcomer = await arriveThroughProvider(browser);
  await expect(newcomer.page).toHaveURL(/\/invite\/sso$/);
  const username = `invited${randomBytes(3).toString("hex")}`;
  await newcomer.page.getByLabel("Username").fill(username);
  await newcomer.page.getByLabel("Full name").fill("Invited Person");
  await newcomer.page.getByRole("button", { name: "Create my account" }).click();
  await expect(newcomer.page).toHaveURL(/\/projects/);
  await newcomer.context.close();

  expect(await accountFor(email)).toMatchObject({ username, role: "admin" });
  expect((await (await db()).collection("invitations").findOne({ email }))?.status).toBe("accepted");
});
