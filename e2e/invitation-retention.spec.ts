import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { signIn } from "./session";
import { E2E_MONGODB_URI, PROJECT_NAME, seed } from "./seed";

/**
 * BP-947, storage limitation. An invitation is deleted by Mongo's TTL monitor 90 days after it was
 * accepted, revoked or, still pending, expired; a pending invitation inside that window stays on
 * Settings → Users. The monitor runs once a minute, so the test waits for it rather than faking it.
 */

const DAY = 24 * 60 * 60 * 1000;

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function invite(page: Page, email: string) {
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Invite someone" });
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByRole("checkbox", { name: new RegExp(PROJECT_NAME) }).check();
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/invitations") && r.request().method() === "POST"),
    dialog.getByRole("button", { name: "Send invitation" }).click(),
  ]);
  expect(response.status()).toBe(201);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("pending-invitation").filter({ hasText: email })).toBeVisible();
}

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("an invitation is deleted 90 days after it was accepted, revoked or expired, and a pending one inside that stays listed", async ({ page }) => {
  test.setTimeout(240_000);
  const run = `${Date.now()}`;
  const address = (label: string) => `${label}-${run}@example.com`;
  const gone = [address("lapsed-long"), address("revoked-long"), address("accepted-long")];
  const kept = [address("lapsed-recent"), address("accepted-recent"), address("live")];

  await signIn(page, "admin");
  await page.goto("/settings/users");
  for (const email of [...gone, ...kept]) await invite(page, email);

  const revokedAt = Date.now();
  const revokedRow = page.getByTestId("pending-invitation").filter({ hasText: address("revoked-long") });
  await revokedRow.getByRole("button", { name: `Revoke the invitation for ${address("revoked-long")}` }).click();
  const [revoked] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes("/api/invitations/")),
    page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click(),
  ]);
  expect(revoked.status()).toBe(200);

  const invitations = (await db()).collection("invitations");
  // Revoking through the app stamps updatedAt, which is what the revoked row's TTL counts from
  const afterRevoke = await invitations.findOne({ email: address("revoked-long") });
  expect(afterRevoke).toMatchObject({ status: "revoked" });
  expect((afterRevoke!.updatedAt as Date).getTime()).toBeGreaterThanOrEqual(revokedAt - 1_000);

  const ago = (days: number) => new Date(Date.now() - days * DAY);
  const set = (email: string, fields: Record<string, unknown>) => invitations.updateOne({ email }, { $set: fields });
  await set(address("lapsed-long"), { expiresAt: ago(91) });
  await set(address("revoked-long"), { updatedAt: ago(91) });
  await set(address("accepted-long"), { status: "accepted", acceptedAt: ago(91) });
  await set(address("lapsed-recent"), { expiresAt: ago(30) });
  await set(address("accepted-recent"), { status: "accepted", acceptedAt: ago(30) });

  await expect
    .poll(async () => (await invitations.indexes()).filter((index) => index.expireAfterSeconds === 90 * 24 * 60 * 60).length)
    .toBe(3);
  await expect
    .poll(async () => invitations.countDocuments({ email: { $in: gone } }), { timeout: 150_000, intervals: [2_000] })
    .toBe(0);
  expect(await invitations.countDocuments({ email: { $in: kept } })).toBe(kept.length);

  const [listed] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/invitations") && r.request().method() === "GET"),
    page.reload(),
  ]);
  expect(listed.status()).toBe(200);
  const rows = page.getByTestId("pending-invitation");
  await expect(rows.filter({ hasText: address("live") })).toContainText("Invited");
  await expect(rows.filter({ hasText: address("lapsed-recent") })).toContainText("Expired");
  await expect(rows.filter({ hasText: address("lapsed-long") })).toHaveCount(0);
  await expect(rows.filter({ hasText: address("accepted-recent") })).toHaveCount(0);
});
