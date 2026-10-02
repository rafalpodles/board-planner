import { test, expect, type Browser, type Page } from "@playwright/test";
import { createHash, randomBytes } from "crypto";
import mongoose from "mongoose";
import { OIDC_STUB_LABEL, OIDC_STUB_URL } from "../playwright.config";
import { ADMIN_ID, E2E_MONGODB_URI, MEMBER_ID, MEMBER_USERNAME, PROJECT_ID, seed } from "./seed";

/**
 * BP-828. Signing in, and accepting an invitation, through an OpenID Connect provider — the e2e
 * rig's stub, which approves whoever `/control` names. The app's half is driven in the browser;
 * the provider's half is the stub's immediate redirect, as a real one would be after its login.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

function freshAddress(label: string) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

async function nextPerson(person: { sub: string; email: string; email_verified?: boolean; name?: string }) {
  const res = await fetch(`${OIDC_STUB_URL}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email_verified: true, name: "Sso Person", ...person }),
  });
  expect(res.ok, "the OIDC stub refused its script").toBe(true);
}

const alertOn = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');
const providerButton = (page: Page, verb = "Continue with") =>
  page.getByRole("button", { name: `${verb} ${OIDC_STUB_LABEL}` });

async function signInWithProvider(page: Page) {
  await page.goto("/login");
  await providerButton(page).click();
}

async function plantInvitation(email: string) {
  const token = `cpi_${randomBytes(32).toString("hex")}`;
  await (await db()).collection("invitations").insertOne({
    email,
    role: "member",
    boards: [{ project: PROJECT_ID, relation: "member", addedBy: ADMIN_ID }],
    invitedBy: ADMIN_ID,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    status: "pending",
    acceptedBy: null,
    acceptedAt: null,
    deliveredAs: "email",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return token;
}

async function fresh(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("an account signs in with the provider by its verified address, and is linked for next time", async ({ page, browser }) => {
  const email = freshAddress("member");
  await (await db()).collection("users").updateOne({ _id: MEMBER_ID }, { $set: { email } });
  const sub = `sub-${randomBytes(4).toString("hex")}`;
  await nextPerson({ sub, email });

  await signInWithProvider(page);

  await expect(page).toHaveURL(/\/projects/);
  const me = await page.request.get("/api/auth/me");
  expect((await me.json()).username).toBe(MEMBER_USERNAME);
  expect(await (await db()).collection("identities").findOne({ subject: sub })).toMatchObject({
    user: MEMBER_ID,
    provider: "oidc",
    email,
  });
  expect(
    await (await db()).collection("instanceauditlogs").findOne({ action: "identity_linked" })
  ).toMatchObject({ target: MEMBER_USERNAME });

  // Linked by subject from now on: the provider changing the address it reports changes nothing
  const later = await fresh(browser);
  await nextPerson({ sub, email: freshAddress("renamed") });
  await signInWithProvider(later.page);
  await expect(later.page).toHaveURL(/\/projects/);
  expect((await (await later.page.request.get("/api/auth/me")).json()).username).toBe(MEMBER_USERNAME);
  await later.context.close();
});

test("an address the provider has not verified does not sign anybody in", async ({ page }) => {
  const email = freshAddress("member");
  await (await db()).collection("users").updateOne({ _id: MEMBER_ID }, { $set: { email } });
  await nextPerson({ sub: "unverified-sub", email, email_verified: false });

  await signInWithProvider(page);

  await expect(page).toHaveURL(/\/login\?sso=unverified/);
  await expect(alertOn(page)).toHaveText(
    "That provider has not confirmed your address, so it cannot sign you in here."
  );
  expect(await (await db()).collection("identities").countDocuments()).toBe(0);
  expect((await page.request.get("/api/auth/me")).status()).toBe(401);
});

test("an address no account uses is refused, and no account is made", async ({ page }) => {
  await nextPerson({ sub: "stranger-sub", email: freshAddress("stranger") });
  const before = await (await db()).collection("users").countDocuments();

  await signInWithProvider(page);

  await expect(alertOn(page)).toHaveText(
    "No account here uses that address. Ask an administrator for an invitation."
  );
  expect(await (await db()).collection("users").countDocuments()).toBe(before);
});

// The round trip is bound to the browser that began it, and spent once
test("a callback replayed, or arriving in another browser, signs nobody in", async ({ page, browser }) => {
  const email = freshAddress("member");
  await (await db()).collection("users").updateOne({ _id: MEMBER_ID }, { $set: { email } });
  await nextPerson({ sub: "replay-sub", email });
  const [callback] = await Promise.all([
    page.waitForRequest((r) => r.url().includes("/api/auth/oidc/oidc/callback")),
    signInWithProvider(page),
  ]);
  await expect(page).toHaveURL(/\/projects/);

  const elsewhere = await fresh(browser);
  await elsewhere.page.goto(callback.url());
  await expect(elsewhere.page).toHaveURL(/\/login\?sso=failed/);
  expect((await elsewhere.page.request.get("/api/auth/me")).status()).toBe(401);
  await elsewhere.context.close();

  const replayed = await fresh(browser);
  await replayed.page.goto("/login");
  await replayed.page.goto(callback.url());
  await expect(replayed.page).toHaveURL(/\/login\?sso=failed/);
  await replayed.context.close();
});

test("an invitation is accepted with the provider, and the account then signs in with it alone", async ({ browser }) => {
  const email = freshAddress("invitee");
  const token = await plantInvitation(email);
  const sub = `inv-${randomBytes(4).toString("hex")}`;
  await nextPerson({ sub, email });

  const { context, page } = await fresh(browser);
  await page.goto(`/invite?token=${token}`);
  await providerButton(page, "Accept with").click();
  await expect(page).toHaveURL(/\/invite\/sso$/);
  await expect(page.getByText(`${OIDC_STUB_LABEL} confirmed ${email}. Choose your username to finish.`)).toBeVisible();
  await page.getByLabel("Username").fill("sso-invitee");
  await page.getByLabel("Full name").fill("Sso Invitee");
  await page.getByRole("button", { name: "Create my account" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}`));

  const handle = await db();
  const account = await handle.collection("users").findOne({ username: "sso-invitee" });
  expect(account).toMatchObject({ email, role: "member" });
  expect(account!.password).toBeUndefined();
  expect(await handle.collection("identities").findOne({ subject: sub })).toMatchObject({ user: account!._id });
  expect(await handle.collection("grants").findOne({ subject: account!._id, object: PROJECT_ID })).toBeTruthy();
  await context.close();

  const again = await fresh(browser);
  await signInWithProvider(again.page);
  await expect(again.page).toHaveURL(/\/projects/);
  expect((await (await again.page.request.get("/api/auth/me")).json()).username).toBe("sso-invitee");

  // Its only way in: the password form is gone, and the provider cannot be unlinked
  await again.page.goto("/settings/security");
  await expect(again.page.getByText("This account has no password.")).toBeVisible();
  await again.page.getByRole("button", { name: `Unlink ${OIDC_STUB_LABEL}` }).click();
  const [refused] = await Promise.all([
    again.page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes("/identities/")),
    again.page.getByRole("dialog").getByRole("button", { name: "Unlink" }).click(),
  ]);
  expect(refused.status()).toBe(409);
  await expect(again.page.getByRole("dialog")).toContainText("This is your only way to sign in.");
  await again.context.close();
});

test("an invitation is not accepted with a provider that confirmed another address", async ({ browser }) => {
  const email = freshAddress("invitee");
  const token = await plantInvitation(email);
  await nextPerson({ sub: "someone-else", email: freshAddress("someone-else") });

  const { context, page } = await fresh(browser);
  await page.goto(`/invite?token=${token}`);
  await providerButton(page, "Accept with").click();

  await expect(page).toHaveURL(/\/invite\/sso\?error=mismatch/);
  await expect(alertOn(page)).toContainText("a different address from the one invited");
  expect(await (await db()).collection("invitations").findOne({ email })).toMatchObject({ status: "pending" });
  await context.close();
});
