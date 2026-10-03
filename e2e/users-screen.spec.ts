import { test, expect, type Browser, type Page } from "@playwright/test";
import { createHash, randomBytes } from "crypto";
import mongoose from "mongoose";
import { OIDC_STUB_LABEL, OIDC_STUB_URL } from "../playwright.config";
import { ADMIN_ID, E2E_MONGODB_URI, MEMBER_ID, MEMBER_PASSWORD, MEMBER_USERNAME, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-831. Settings → Users: one list of active accounts, pending invitations and deactivated
 * accounts, each with its status, when it last signed in and how it can.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

const memberCard = (page: Page) =>
  page.locator("div").filter({ has: page.getByText(`@${MEMBER_USERNAME}`, { exact: true }) }).last();

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

test("a sign-in by password, then by a provider, is what the list says and how", async ({ page, browser }) => {
  await signIn(page);
  await page.goto("/settings/users");
  await expect(memberCard(page)).toContainText("Never signed in · Password");

  const byPassword = await fresh(browser);
  await byPassword.page.goto("/login");
  await byPassword.page.getByLabel("Username").fill(MEMBER_USERNAME);
  await byPassword.page.getByLabel("Password").fill(MEMBER_PASSWORD);
  await byPassword.page.getByRole("button", { name: "Sign In" }).click();
  await expect(byPassword.page).toHaveURL(/\/projects/);
  await byPassword.context.close();

  await page.reload();
  await expect(memberCard(page)).toContainText("Signed in just now · Password");

  // A provider sign-in stamps it too, and the provider joins the list of ways in
  const email = `member-${randomBytes(4).toString("hex")}@example.com`;
  await (await db()).collection("users").updateOne({ _id: MEMBER_ID }, { $set: { email, emailVerifiedAt: new Date(), lastSignInAt: null } });
  await fetch(`${OIDC_STUB_URL}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sub: `sub-${randomBytes(4).toString("hex")}`, email, email_verified: true, name: "Member" }),
  });
  const byProvider = await fresh(browser);
  await byProvider.page.goto("/login");
  await byProvider.page.getByRole("button", { name: `Continue with ${OIDC_STUB_LABEL}` }).click();
  await expect(byProvider.page).toHaveURL(/\/projects/);
  await byProvider.context.close();

  await page.reload();
  await expect(memberCard(page)).toContainText(`Signed in just now · Password, ${OIDC_STUB_LABEL}`);
});

test("the list filters by status, and counts each", async ({ page }) => {
  await (await db()).collection("users").updateOne({ _id: MEMBER_ID }, { $set: { deactivatedAt: new Date() } });
  const token = `cpi_${randomBytes(32).toString("hex")}`;
  await (await db()).collection("invitations").insertOne({
    email: "newcomer@example.com",
    role: "member",
    boards: [],
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

  await signIn(page);
  await page.goto("/settings/users");
  const show = page.getByRole("group", { name: "Show" });
  await expect(page.getByText("newcomer@example.com")).toBeVisible();
  await expect(page.getByText(`@${MEMBER_USERNAME}`, { exact: true })).toBeVisible();

  await show.getByRole("button", { name: /^Deactivated 1$/ }).click();
  await expect(page.getByText(`@${MEMBER_USERNAME}`, { exact: true })).toBeVisible();
  await expect(page.getByText("@admin", { exact: true })).toHaveCount(0);
  await expect(page.getByText("newcomer@example.com")).toHaveCount(0);

  await show.getByRole("button", { name: /^Invited 1$/ }).click();
  await expect(page.getByText("newcomer@example.com")).toBeVisible();
  await expect(page.getByText(`@${MEMBER_USERNAME}`, { exact: true })).toHaveCount(0);

  await show.getByRole("button", { name: /^Active / }).click();
  await expect(page.getByText("@admin", { exact: true })).toBeVisible();
  await expect(page.getByText(`@${MEMBER_USERNAME}`, { exact: true })).toHaveCount(0);
});
