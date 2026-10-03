import { test, expect } from "@playwright/test";
import { randomBytes } from "crypto";
import mongoose from "mongoose";
import { OIDC_STUB_LABEL, OIDC_STUB_URL } from "../playwright.config";
import { E2E_MONGODB_URI, MEMBER_ID, MEMBER_USERNAME, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-844. The Users, Security and Profile screens say what is true about providers and passwords,
 * and do not lose what somebody typed.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

const memberCard = (page: import("@playwright/test").Page) =>
  page.locator("div").filter({ has: page.getByText(`@${MEMBER_USERNAME}`, { exact: true }) }).last();

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("signing somebody out everywhere takes the providers it unlinked off their card at once", async ({ page }) => {
  await (await db()).collection("identities").insertOne({
    user: MEMBER_ID,
    provider: "oidc",
    issuer: OIDC_STUB_URL,
    subject: `sub-${randomBytes(4).toString("hex")}`,
    email: "member@example.com",
    linkedAt: new Date(),
    lastUsedAt: new Date(),
  });
  await signIn(page);
  await page.goto("/settings/users");
  await expect(memberCard(page)).toContainText(`Password, ${OIDC_STUB_LABEL}`);

  await page.getByText(`@${MEMBER_USERNAME}`, { exact: true }).click();
  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Sign out everywhere" }).click();

  await expect(memberCard(page)).not.toContainText(OIDC_STUB_LABEL);
  await expect(memberCard(page)).toContainText("Password");
});

test("the edit dialog holds its account actions while an edit is unsaved", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/users");
  await page.getByText(`@${MEMBER_USERNAME}`, { exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Deactivate", exact: true })).toBeEnabled();

  await dialog.getByLabel("Email").fill("typed-not-saved@example.com");

  await expect(dialog.getByText("Save or cancel your changes first.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Deactivate", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Sign out everywhere" })).toBeDisabled();
  await expect(dialog.getByLabel("Email")).toHaveValue("typed-not-saved@example.com");
});

test("Security keeps the password form when the providers cannot be read", async ({ page }) => {
  await signIn(page, "member");
  await page.route("**/api/users/me/identities", (route) => route.fulfill({ status: 500, body: "{}" }));
  await page.goto("/settings/security");

  await expect(page.getByText("Could not load your sign-in providers. Reload the page to try again.")).toBeVisible();
  await expect(page.getByLabel("Current password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change password" })).toBeVisible();
});

test("Profile tells an account with no password how to change its address", async ({ page }) => {
  await (await db()).collection("users").updateOne({ _id: MEMBER_ID }, { $unset: { password: "" } });
  await signIn(page, "member");
  await page.goto("/settings/profile");

  await page.getByLabel("Email").fill("somewhere-new@example.com");

  await expect(page.getByText(/this account has none/)).toBeVisible();
  await expect(page.getByLabel("Current password")).toHaveCount(0);
});
