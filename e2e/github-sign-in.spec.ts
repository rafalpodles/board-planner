import { test, expect, type Browser, type Page } from "@playwright/test";
import { createHash, randomBytes } from "crypto";
import mongoose from "mongoose";
import { GITHUB_STUB_URL } from "../playwright.config";
import { ADMIN_ID, E2E_MONGODB_URI, MEMBER_ID, MEMBER_PASSWORD, MEMBER_USERNAME, PROJECT_ID, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-829. Signing in, linking and accepting an invitation with GitHub, which is OAuth 2 without
 * OpenID Connect: the person is read from the e2e GitHub stub's `/user` and `/user/emails`, and
 * `/oauth/control` names who approves next.
 */

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

function freshAddress(label: string) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

function freshId() {
  return 100000 + Math.floor(Math.random() * 1e9);
}

async function nextPerson(person: { id: number; login?: string; name?: string; emails: GitHubEmail[] }) {
  const res = await fetch(`${GITHUB_STUB_URL}/oauth/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: "octo", name: "Octo Person", ...person }),
  });
  expect(res.ok, "the GitHub stub refused its script").toBe(true);
}

const primary = (email: string, verified = true): GitHubEmail => ({ email, primary: true, verified });
const alertOn = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

async function signInWithGitHub(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
}

async function whoAmI(page: Page) {
  return (await (await page.request.get("/api/auth/me")).json()).username;
}

async function fresh(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

async function proveMemberAddress(email: string) {
  await (await db()).collection("users").updateOne({ _id: MEMBER_ID }, { $set: { email, emailVerifiedAt: new Date() } });
}

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("an account signs in with GitHub by its verified primary address, and is linked by GitHub's id", async ({
  page,
  browser,
}) => {
  const email = freshAddress("member");
  await proveMemberAddress(email);
  const id = freshId();
  await nextPerson({ id, emails: [{ email: freshAddress("other"), primary: false, verified: true }, primary(email)] });

  await signInWithGitHub(page);

  await expect(page).toHaveURL(/\/projects/);
  expect(await whoAmI(page)).toBe(MEMBER_USERNAME);
  expect(await (await db()).collection("identities").findOne({ subject: String(id) })).toMatchObject({
    user: MEMBER_ID,
    provider: "github",
    issuer: GITHUB_STUB_URL,
    email,
  });

  const asked = await (await fetch(`${GITHUB_STUB_URL}/oauth/last-authorize`)).json();
  expect(asked).toMatchObject({ scope: "read:user user:email", code_challenge_method: "S256" });
  expect(asked.state).toBeTruthy();

  // From now on by id: the address GitHub lists changing changes nothing
  const later = await fresh(browser);
  await nextPerson({ id, emails: [primary(freshAddress("renamed"))] });
  await signInWithGitHub(later.page);
  await expect(later.page).toHaveURL(/\/projects/);
  expect(await whoAmI(later.page)).toBe(MEMBER_USERNAME);
  await later.context.close();
});

test("an address GitHub has not verified links nobody", async ({ page }) => {
  const email = freshAddress("member");
  await proveMemberAddress(email);
  await nextPerson({ id: freshId(), emails: [primary(email, false)] });

  await signInWithGitHub(page);

  await expect(page).toHaveURL(/\/login\?sso=unverified/);
  await expect(alertOn(page)).toContainText("That provider has not confirmed your address");
  expect(await (await db()).collection("identities").countDocuments()).toBe(0);
  expect((await page.request.get("/api/auth/me")).status()).toBe(401);
});

test("a verified address that is not the primary one still counts when the primary is unverified", async ({ page }) => {
  const email = freshAddress("member");
  await proveMemberAddress(email);
  await nextPerson({
    id: freshId(),
    emails: [primary(freshAddress("unconfirmed"), false), { email, primary: false, verified: true }],
  });

  await signInWithGitHub(page);

  await expect(page).toHaveURL(/\/projects/);
  expect(await whoAmI(page)).toBe(MEMBER_USERNAME);
});

test("a signed-in account links GitHub from its settings, then signs in with it", async ({ page, browser }) => {
  await signIn(page, "member");
  const id = freshId();
  await nextPerson({ id, emails: [primary(freshAddress("personal"))] });

  await page.goto("/settings/security");
  await page.getByLabel("Your password, to link a provider").fill(MEMBER_PASSWORD);
  await page.getByRole("button", { name: "Link GitHub" }).click();

  await expect(page.getByTestId("toast").filter({ hasText: "Linked. You can now sign in with it." })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Unlink GitHub" })).toBeVisible();

  const later = await fresh(browser);
  await nextPerson({ id, emails: [primary(freshAddress("personal"))] });
  await signInWithGitHub(later.page);
  await expect(later.page).toHaveURL(/\/projects/);
  expect(await whoAmI(later.page)).toBe(MEMBER_USERNAME);
  await later.context.close();
});

test("an invitation is accepted with GitHub, and the account then signs in with it alone", async ({ browser }) => {
  const email = freshAddress("invitee");
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
  const id = freshId();
  await nextPerson({ id, emails: [primary(email)] });

  const { context, page } = await fresh(browser);
  await page.goto(`/invite?token=${token}`);
  await page.getByRole("button", { name: "Accept with GitHub" }).click();
  await expect(page).toHaveURL(/\/invite\/sso$/);
  await expect(page.getByText(`GitHub confirmed ${email}. Choose your username to finish.`)).toBeVisible();
  await page.getByLabel("Username").fill("octo-invitee");
  await page.getByLabel("Full name").fill("Octo Invitee");
  await page.getByRole("button", { name: "Create my account" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}`));

  const account = await (await db()).collection("users").findOne({ username: "octo-invitee" });
  expect(account).toMatchObject({ email });
  expect(account!.password).toBeUndefined();
  expect(await (await db()).collection("identities").findOne({ subject: String(id) })).toMatchObject({
    user: account!._id,
    provider: "github",
  });
  await context.close();

  const again = await fresh(browser);
  await signInWithGitHub(again.page);
  await expect(again.page).toHaveURL(/\/projects/);
  expect(await whoAmI(again.page)).toBe("octo-invitee");
  await again.context.close();
});
