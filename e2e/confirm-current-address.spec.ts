import { test, expect, type Page, type TestInfo } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, MEMBER_ID, seed } from "./seed";
import { signIn, signInContext } from "./session";
import { bodyOf, confirmLinkIn, mailFor } from "./mailbox";

/**
 * BP-928. An account that predates address confirmation has an address and no proof of it, and
 * following a sign-in that asks for proof was only possible by moving the address through another
 * one. The profile now sends a link to the address the account already has.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

const storedMember = async () => (await db()).collection("users").findOne({ _id: MEMBER_ID });

const addressFor = (attempt: TestInfo) => `current-${attempt.testId}-${attempt.repeatEachIndex}-${attempt.retry}@e2e.invalid`;

async function withAddress(address: string, proof: { emailVerifiedAt: Date | null; emailVouchedByAdmin?: boolean }) {
  await (await db()).collection("users").updateOne({ _id: MEMBER_ID }, { $set: { email: address, ...proof } });
}

async function openProfile(page: Page, address: string) {
  await signIn(page, "member");
  await page.goto("/settings/profile");
  await expect(page.getByLabel("Email")).toHaveValue(address);
}

test.beforeEach(seed);

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("an address with no proof is confirmed by the link sent to it, and the address does not move", async ({ page, browser }, testInfo) => {
  const address = addressFor(testInfo);
  await withAddress(address, { emailVerifiedAt: null });
  await openProfile(page, address);
  await expect(page.getByTestId("confirm-address")).toContainText("not confirmed yet");
  await page.screenshot({ path: "e2e/.artifacts/bp928-profile-unconfirmed.png" });

  await page.getByRole("button", { name: "Confirm this address" }).click();
  await expect(page.getByRole("status").filter({ hasText: `We sent a confirmation link to ${address}` })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: `We sent a confirmation link to ${address}` })).toBeFocused();
  await expect(page.getByRole("button", { name: "Confirm this address" })).toHaveCount(0);
  await page.screenshot({ path: "e2e/.artifacts/bp928-profile-sent.png" });

  await expect.poll(async () => (await mailFor(address)).length, { timeout: 30_000 }).toBe(1);
  const message = (await mailFor(address))[0];
  expect(bodyOf(message)).toContain("already uses this address");

  const inbox = await browser.newPage();
  await inbox.goto(confirmLinkIn(message));
  await inbox.getByRole("button", { name: "Confirm this address" }).click();
  await expect(inbox.getByRole("heading", { name: "Address confirmed" })).toBeVisible();
  await inbox.close();

  const member = await storedMember();
  expect(member?.email).toBe(address);
  expect(member?.emailVerifiedAt).toBeInstanceOf(Date);
  expect(member?.emailVouchedByAdmin).toBe(false);
  // Nothing about a change of address: this is not one
  expect(await mailFor(address)).toHaveLength(1);

  await page.reload();
  await expect(page.getByTestId("address-confirmed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm this address" })).toHaveCount(0);
  const audited = await (await db()).collection("instanceauditlogs").countDocuments({ action: "user_email_confirmed_self", detail: address });
  expect(audited).toBe(1);
});

test("an address already confirmed by its owner offers no button and sends no mail", async ({ page }, testInfo) => {
  const address = addressFor(testInfo);
  await withAddress(address, { emailVerifiedAt: new Date(), emailVouchedByAdmin: false });
  await openProfile(page, address);

  await expect(page.getByTestId("address-confirmed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm this address" })).toHaveCount(0);
  const direct = await page.request.post("/api/users/me/email-change", { data: {}, headers: { "sec-fetch-site": "same-origin" } });
  expect(await direct.json()).toEqual({ confirmed: true });
  expect(await mailFor(address)).toHaveLength(0);
});

test("an administrator's word for an address is not the owner's, so the button is there and replaces it", async ({ page, browser }, testInfo) => {
  const address = addressFor(testInfo);
  await withAddress(address, { emailVerifiedAt: new Date(), emailVouchedByAdmin: true });
  await openProfile(page, address);

  await page.getByRole("button", { name: "Confirm this address" }).click();
  await expect.poll(async () => (await mailFor(address)).length, { timeout: 30_000 }).toBe(1);
  const inbox = await browser.newPage();
  await inbox.goto(confirmLinkIn((await mailFor(address))[0]));
  await inbox.getByRole("button", { name: "Confirm this address" }).click();
  await expect(inbox.getByRole("heading", { name: "Address confirmed" })).toBeVisible();
  await inbox.close();

  const member = await storedMember();
  expect(member?.emailVouchedByAdmin).toBe(false);
  expect(member?.emailVerifiedAt).toBeInstanceOf(Date);
});

test("a link for the address an account had proves nothing once an administrator has moved the address", async ({ page, browser }, testInfo) => {
  const address = addressFor(testInfo);
  await withAddress(address, { emailVerifiedAt: null });
  await openProfile(page, address);
  await page.getByRole("button", { name: "Confirm this address" }).click();
  await expect.poll(async () => (await mailFor(address)).length, { timeout: 30_000 }).toBe(1);
  const link = confirmLinkIn((await mailFor(address))[0]);

  const admin = await browser.newContext();
  await signInContext(admin, "admin");
  const moved = await admin.request.put(`/api/users/${MEMBER_ID}`, { headers: { "sec-fetch-site": "same-origin" }, data: { email: `moved-${address}` } });
  expect(moved.status()).toBe(200);
  await admin.close();

  const inbox = await browser.newPage();
  await inbox.goto(link);
  await inbox.getByRole("button", { name: "Confirm this address" }).click();
  await expect(inbox.getByText("This link is not valid")).toBeVisible();
  await inbox.close();
  expect((await storedMember())?.email).toBe(`moved-${address}`);
});

test("a change of address waiting for its link keeps the button away, and the endpoint refuses", async ({ page }, testInfo) => {
  const address = addressFor(testInfo);
  await withAddress(address, { emailVerifiedAt: null });
  await openProfile(page, address);
  const next = `next-${address}`;
  await page.getByLabel("Email").fill(next);
  await page.getByLabel("Current password").fill("test1234");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: next })).toBeVisible();

  await expect(page.getByTestId("confirm-address")).toHaveCount(0);
  expect((await page.request.post("/api/users/me/email-change", { data: {}, headers: { "sec-fetch-site": "same-origin" } })).status()).toBe(409);
});

test("at phone width the unconfirmed address and its button fit the screen", async ({ page }, testInfo) => {
  const address = addressFor(testInfo);
  await withAddress(address, { emailVerifiedAt: null });
  await page.setViewportSize({ width: 375, height: 812 });
  await openProfile(page, address);

  await expect(page.getByRole("button", { name: "Confirm this address" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.screenshot({ path: "e2e/.artifacts/bp928-profile-phone.png" });
});
