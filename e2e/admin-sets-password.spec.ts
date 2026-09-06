import { test, expect, type Page, type Response } from "@playwright/test";
import bcrypt from "bcryptjs";
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

const NEW_PASSWORD = "handed-over-in-person";

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function auditRows() {
  const handle = await db();
  return handle.collection("instanceauditlogs").find({}).sort({ createdAt: -1 }).toArray();
}

async function signIn(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
}

async function signInAsAdmin(page: Page) {
  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/projects/);
}

async function openMemberInUserSettings(page: Page) {
  await page.goto("/settings/users");
  await page.getByText(`@${MEMBER_USERNAME}`, { exact: true }).first().click();
  await expect(page.getByLabel("Set a new password")).toBeVisible();
}

async function setMemberPassword(page: Page, password = NEW_PASSWORD): Promise<Response> {
  await page.getByLabel("Set a new password").fill(password);
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => /\/api\/users\/\w+$/.test(new URL(r.url()).pathname) && r.request().method() === "PUT"
    ),
    page.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  await expect(page.getByText(`Password set for ${MEMBER_USERNAME}`)).toBeVisible();
  return response;
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
  const response = await setMemberPassword(page);

  expect(await response.json()).not.toHaveProperty("password");

  await page.goto("/settings/audit");
  const row = page.getByRole("row").filter({ hasText: "Password set by an admin" });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("cell", { name: ADMIN_USERNAME, exact: true })).toHaveCount(1);
  await expect(row.getByRole("cell", { name: MEMBER_USERNAME, exact: true })).toHaveCount(1);

  await page.context().clearCookies();
  await signIn(page, MEMBER_USERNAME, NEW_PASSWORD);
  await expect(page).toHaveURL(/\/projects/);
});

test("the old password stops working", async ({ page }) => {
  await signInAsAdmin(page);
  await openMemberInUserSettings(page);
  await setMemberPassword(page);

  await page.context().clearCookies();
  await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);

  await expect(page.getByText("Invalid credentials")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("the reset ends the session the member already had", async ({ browser }) => {
  const memberContext = await browser.newContext();
  const adminContext = await browser.newContext();
  try {
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, MEMBER_USERNAME, MEMBER_PASSWORD);
    await expect(memberPage).toHaveURL(/\/projects/);

    const adminPage = await adminContext.newPage();
    await signInAsAdmin(adminPage);
    await openMemberInUserSettings(adminPage);
    await setMemberPassword(adminPage);

    await memberPage.reload();
    await expect(memberPage).toHaveURL(/\/login/);
  } finally {
    await memberContext.close();
    await adminContext.close();
  }
});

test("an admin is not offered the field on their own account", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/settings/users");
  await page.getByText(`@${ADMIN_USERNAME}`, { exact: true }).first().click();

  await expect(page.getByText(/Your own password is changed under Settings/)).toBeVisible();
  await expect(page.getByLabel("Set a new password")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show", exact: true })).toHaveCount(0);
});

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
  expect(await bcrypt.compare(MEMBER_PASSWORD, member?.password as string)).toBe(true);
  expect(await auditRows()).toHaveLength(0);
});
