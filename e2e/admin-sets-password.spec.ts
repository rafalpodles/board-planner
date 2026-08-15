import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH } from "./api";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  E2E_MONGODB_URI,
  MEMBER_ID,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  seed,
} from "./seed";

/**
 * BP-281, slice 1. A forgotten password was a database operation: nothing in the interface could
 * give an account a new one, so the only way back in was a shell and a bcrypt hash.
 *
 * Driven through the browser on both sides — an admin sets it, and the account it belongs to then
 * signs in with it. Asserting the PUT returned 200 would prove the handler ran, not that anybody
 * got back into their account, which is the whole of what the ticket asks for.
 */

const NEW_PASSWORD = "handed-over-in-person";

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function signIn(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
}

// Landing is awaited, not assumed: navigating straight on from the click races the redirect, and
// the settings screen then renders against an auth state that has not settled.
async function signInAsAdmin(page: Page) {
  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/projects/);
}

async function openMemberInUserSettings(page: Page) {
  await page.goto("/settings/users");
  await page.getByText(`@${MEMBER_USERNAME}`, { exact: true }).first().click();
  await expect(page.getByLabel("Set a new password")).toBeVisible();
}

test.beforeEach(async () => {
  await seed();
  const handle = await db();
  await handle.collection("instanceauditlogs").deleteMany({});
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("an admin sets a member's password, and the member signs in with it", async ({ page }) => {
  await signInAsAdmin(page);

  await openMemberInUserSettings(page);
  await page.getByLabel("Set a new password").fill(NEW_PASSWORD);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/users/") && r.request().method() === "PUT"),
    page.getByRole("button", { name: "Set", exact: true }).click(),
  ]);
  await expect(page.getByText(/Password set for member/)).toBeVisible();

  // An admin setting somebody else's password is exactly what the instance log exists to make
  // provable, and a row nobody can find is not an audit trail
  await page.goto("/settings/audit");
  const row = page.getByRole("row").filter({ hasText: "Password set by an admin" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(MEMBER_USERNAME);
  await expect(row).toContainText(ADMIN_USERNAME);

  // The point of the ticket: the account is reachable again, by its owner, through the front door.
  // Cookies cleared rather than Logout clicked — that control lives behind the sidebar's user
  // menu, and walking it proves nothing about a password.
  await page.context().clearCookies();
  await signIn(page, MEMBER_USERNAME, NEW_PASSWORD);
  await expect(page).toHaveURL(/\/projects/);
});

test("the old password stops working", async ({ page }) => {
  await signInAsAdmin(page);
  await openMemberInUserSettings(page);
  await page.getByLabel("Set a new password").fill(NEW_PASSWORD);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/users/") && r.request().method() === "PUT"),
    page.getByRole("button", { name: "Set", exact: true }).click(),
  ]);
  await expect(page.getByText(/Password set for member/)).toBeVisible();

  await page.context().clearCookies();
  await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);

  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText("Invalid credentials")).toBeVisible();
});

// Whoever knew the old password may be signed in right now — that is the case a reset is usually
// answering. Two contexts, because one browser cannot hold two sessions of this app at once.
test("the reset ends the session the member already had", async ({ browser }) => {
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await signIn(memberPage, MEMBER_USERNAME, MEMBER_PASSWORD);
  await expect(memberPage).toHaveURL(/\/projects/);

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signInAsAdmin(adminPage);
  await openMemberInUserSettings(adminPage);
  await adminPage.getByLabel("Set a new password").fill(NEW_PASSWORD);
  await Promise.all([
    adminPage.waitForResponse(
      (r) => r.url().includes("/api/users/") && r.request().method() === "PUT"
    ),
    adminPage.getByRole("button", { name: "Set", exact: true }).click(),
  ]);
  await expect(adminPage.getByText(/Password set for member/)).toBeVisible();

  await memberPage.reload();
  await expect(memberPage).toHaveURL(/\/login/);

  await memberContext.close();
  await adminContext.close();
});

// The current-password check on Settings → Security is the only thing between a borrowed admin
// session and an owner locked out of their own account. The field is not offered here.
test("an admin is not offered the field on their own account", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/settings/users");
  await page.getByText(`@${ADMIN_USERNAME}`, { exact: true }).first().click();

  await expect(page.getByText(/Your own password is changed under Settings/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Set", exact: true })).toBeHidden();
});

// No gesture can produce this: the screen is only reachable with a browser session. Setting an
// admin's password is the shorter half of the promote-then-sign-in escape a machine credential is
// refused everywhere else, so the endpoint has to refuse it too.
test("an admin API token cannot set a password", async ({ request }) => {
  const response = await request.put(`/api/users/${MEMBER_ID.toString()}`, {
    headers: ADMIN_AUTH,
    data: { password: NEW_PASSWORD },
  });

  expect(response.status()).toBe(403);

  const handle = await db();
  const member = await handle
    .collection("users")
    .findOne({ _id: MEMBER_ID }, { projection: { password: 1 } });
  const bcrypt = await import("bcryptjs");
  expect(await bcrypt.default.compare(MEMBER_PASSWORD, member?.password as string)).toBe(true);
});
