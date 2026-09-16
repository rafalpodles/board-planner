import { test, expect, type Page, type TestInfo } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, MEMBER_ID, MEMBER_PASSWORD, seed } from "./seed";
import { signIn } from "./session";
import { confirmLinkIn, mailFor } from "./mailbox";

/**
 * BP-359. Changing your own address used to store it at once and mail the old one, so anybody could
 * make this instance mail a stranger — and a typo left the account with a recovery address nobody
 * reads. Now the new address is held until a link sent to it is followed and confirmed.
 *
 * The mail is real: it goes through nodemailer to the SMTP stub, and the link the test follows is
 * the one in the message, not one the test assembled. Each attempt owns its addresses, because the
 * stub's log outlives a test.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function storedEmail(): Promise<string> {
  const member = await (await db()).collection("users").findOne({ _id: MEMBER_ID });
  return member?.email ?? "";
}

// The test's id as well as the attempt: the stub's log holds every earlier test's mail too
const addresses = (attempt: TestInfo) => {
  const tag = `${attempt.testId}-${attempt.repeatEachIndex}-${attempt.retry}`;
  return { old: `old-${tag}@e2e.invalid`, next: `next-${tag}@e2e.invalid` };
};

async function requestChange(page: Page, next: string, old: string) {
  await signIn(page, "member");
  await page.goto("/settings/profile");
  const email = page.getByLabel("Email");
  // The screen's own load sets the field; a fill before it lands is overwritten
  await expect(email).toHaveValue(old);
  await expect(async () => {
    await email.fill(next);
    await expect(page.getByLabel("Current password")).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await page.getByLabel("Current password").fill(MEMBER_PASSWORD);
  await page.getByRole("button", { name: "Save" }).click();
}

test.beforeEach(seed);

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("a new address takes effect only once the link sent to it is confirmed", async ({ page, browser }, testInfo) => {
  const { old, next } = addresses(testInfo);
  await (await db()).collection("users").updateOne({ _id: MEMBER_ID }, { $set: { email: old } });

  await requestChange(page, next, old);

  await expect(page.getByText(`We sent a confirmation link to ${next}`)).toBeVisible();
  await expect(page.getByRole("status").getByText(next)).toBeVisible();
  // The field shows the address still in force, and so does the database
  await expect(page.getByLabel("Email")).toHaveValue(old);
  expect(await storedEmail()).toBe(old);

  await expect.poll(async () => (await mailFor(next)).length, { timeout: 30_000 }).toBe(1);
  // Nothing to the old address yet: nothing has changed for it
  expect(await mailFor(old)).toHaveLength(0);
  const link = confirmLinkIn((await mailFor(next))[0]);

  // Opened somewhere with no session, the way an inbox on another device opens it
  const inbox = await browser.newPage();
  const confirmations: string[] = [];
  inbox.on("request", (request) => {
    if (request.url().includes("/api/auth/confirm-email")) confirmations.push(request.method());
  });
  await inbox.goto(link);
  await expect(inbox.getByRole("heading", { name: "Confirm this email address" })).toBeVisible();
  // The token has left the address bar — which is also the page's effect having run, the one
  // place a request sent on opening would start
  await expect(inbox).toHaveURL(/\/confirm-email$/);
  // Opening the link is not confirming it: a mail scanner fetching every link must not do this
  expect(confirmations).toEqual([]);
  expect(await storedEmail()).toBe(old);

  await inbox.getByRole("button", { name: "Confirm this address" }).click();

  await expect(inbox.getByRole("heading", { name: "Address confirmed" })).toBeVisible();
  expect(await storedEmail()).toBe(next);
  // Now the address that lost the account is told
  await expect.poll(async () => (await mailFor(old)).length, { timeout: 30_000 }).toBe(1);
  await inbox.close();
});

test("a link already spent cannot confirm again", async ({ page, browser }, testInfo) => {
  const { old, next } = addresses(testInfo);
  await (await db()).collection("users").updateOne({ _id: MEMBER_ID }, { $set: { email: old } });
  await requestChange(page, next, old);
  await expect.poll(async () => (await mailFor(next)).length, { timeout: 30_000 }).toBe(1);
  const link = confirmLinkIn((await mailFor(next))[0]);

  const inbox = await browser.newPage();
  await inbox.goto(link);
  await inbox.getByRole("button", { name: "Confirm this address" }).click();
  await expect(inbox.getByRole("heading", { name: "Address confirmed" })).toBeVisible();

  const again = await browser.newPage();
  await again.goto(link);
  await again.getByRole("button", { name: "Confirm this address" }).click();

  await expect(again.getByText("This link has already been used.")).toBeVisible();
  await inbox.close();
  await again.close();
});

test("cancelling a pending change keeps the address and spends the link", async ({ page, browser }, testInfo) => {
  const { old, next } = addresses(testInfo);
  await (await db()).collection("users").updateOne({ _id: MEMBER_ID }, { $set: { email: old } });
  await requestChange(page, next, old);
  await expect.poll(async () => (await mailFor(next)).length, { timeout: 30_000 }).toBe(1);
  const link = confirmLinkIn((await mailFor(next))[0]);

  await page.getByRole("button", { name: "Cancel this change" }).click();
  await expect(page.getByRole("status").getByText(next)).toHaveCount(0);

  const inbox = await browser.newPage();
  await inbox.goto(link);
  await inbox.getByRole("button", { name: "Confirm this address" }).click();

  await expect(inbox.getByText(/This link is not valid/)).toBeVisible();
  expect(await storedEmail()).toBe(old);
  await inbox.close();
});
