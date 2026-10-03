import { test, expect } from "@playwright/test";
import { randomBytes } from "crypto";
import mongoose from "mongoose";
import { GITHUB_STUB_URL, OIDC_STUB_LABEL } from "../playwright.config";
import { E2E_MONGODB_URI, MEMBER_ID, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-842. A link made while a provider signed as another issuer is no way in once it is repointed:
 * it is not listed, it does not hide Link, and it does not count as the way in that remains.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

const linkFrom = async (provider: string, issuer: string) =>
  (await db()).collection("identities").insertOne({
    user: MEMBER_ID,
    provider,
    issuer,
    subject: `sub-${randomBytes(4).toString("hex")}`,
    email: "member@example.com",
    linkedAt: new Date(),
    lastUsedAt: new Date(),
  });

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("a link from a provider's former issuer is not listed, and Link is offered again", async ({ page }) => {
  await linkFrom("oidc", "https://former-issuer.example");

  await signIn(page, "member");
  await page.goto("/settings/security");

  await expect(page.getByRole("button", { name: `Link ${OIDC_STUB_LABEL}` })).toBeVisible();
  await expect(page.getByRole("button", { name: `Unlink ${OIDC_STUB_LABEL}` })).toHaveCount(0);
});

test("an account's last working provider cannot be unlinked on the strength of a former issuer's link", async ({ page }) => {
  await (await db()).collection("users").updateOne({ _id: MEMBER_ID }, { $unset: { password: "" } });
  await linkFrom("oidc", "https://former-issuer.example");
  await linkFrom("github", GITHUB_STUB_URL);

  await signIn(page, "member");
  await page.goto("/settings/security");
  await page.getByRole("button", { name: "Unlink GitHub" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Unlink" }).click();

  await expect(page.getByRole("dialog")).toContainText("This is your only way to sign in.");
  expect(await (await db()).collection("identities").countDocuments({ user: MEMBER_ID, provider: "github" })).toBe(1);
});
