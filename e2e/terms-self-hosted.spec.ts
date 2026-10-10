import { test, expect } from "@playwright/test";
import { createHash, randomBytes } from "crypto";
import mongoose from "mongoose";
import { ADMIN_ID, E2E_MONGODB_URI, seed } from "./seed";

// BP-939: the cloud terms are the cloud's; a self-hosted instance never shows them, whatever version is set
async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

const publish = async (request: import("@playwright/test").APIRequestContext, version: string | undefined) =>
  expect((await request.post("/api/e2e/legal-terms", { data: { version } })).status()).toBe(204);

test.beforeEach(async ({ request }) => {
  await seed();
  await publish(request, "2026-10-15");
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test.afterAll(async ({ request }) => {
  await publish(request, undefined);
});

test("with a version set but no ORGANISATION_DOMAIN, an invitation shows no terms box and needs none", async ({ page, request }) => {
  expect(await (await request.get("/api/legal/terms")).json()).toEqual({ terms: null });

  const email = `self-${randomBytes(4).toString("hex")}@example.com`;
  const token = `cpi_${randomBytes(32).toString("hex")}`;
  await (await db()).collection("invitations").insertOne({
    email,
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

  await page.goto(`/invite?token=${token}`);
  await page.getByLabel("Username").fill("selfhosted");
  await page.getByLabel("Full name").fill("Self Hosted");
  await page.getByLabel("Password", { exact: true }).fill("a-long-password");
  await page.getByLabel("Confirm password").fill("a-long-password");
  await expect(page.getByRole("button", { name: "Create my account" })).toBeVisible();
  await expect(page.getByTestId("accept-terms")).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);

  const accepted = page.waitForResponse((r) => r.url().endsWith("/api/invitations/accept"));
  await page.getByRole("button", { name: "Create my account" }).click();
  expect((await accepted).status()).toBe(201);
  await page.waitForURL(/\/projects/);
  await expect(page.getByRole("button", { name: /Account menu/ })).toBeVisible();

  const user = await (await db()).collection("users").findOne({ email });
  expect(user).not.toHaveProperty("termsAcceptedVersion");
});
