import { test, expect, type Page } from "@playwright/test";
import { createHash, randomBytes } from "crypto";
import mongoose from "mongoose";
import { OIDC_STUB_LABEL, OIDC_STUB_URL } from "../playwright.config";
import { ADMIN_ID, E2E_MONGODB_URI, MEMBER_PASSWORD, OWNER_ID, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-843. Each way an invitation's journey went wrong: a provider round trip that failed lost where
 * it began, an invitee was told to ask for an invitation, a board owner wiped an administrator's
 * invitation, and a resend granted a board nobody could still grant.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

const fresh = (label: string) => `${label}-${randomBytes(4).toString("hex")}@example.com`;
const alertOn = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

async function stubSignsIn(person: Record<string, unknown>) {
  const res = await fetch(`${OIDC_STUB_URL}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sub: `sub-${randomBytes(4).toString("hex")}`, email_verified: true, ...person }),
  });
  expect(res.ok, "the OIDC stub refused its script").toBe(true);
}

async function invitation(fields: Record<string, unknown>) {
  const doc = {
    role: "member",
    boards: [],
    invitedBy: ADMIN_ID,
    tokenHash: createHash("sha256").update(`cpi_${randomBytes(32).toString("hex")}`).digest("hex"),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    status: "pending",
    acceptedBy: null,
    acceptedAt: null,
    deliveredAs: "email",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields,
  };
  await (await db()).collection("invitations").insertOne(doc);
  return doc;
}

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("cancelling at the provider while linking comes back to Security, not to sign in", async ({ page }) => {
  await stubSignsIn({ email: fresh("member"), deny: true });
  await signIn(page, "member");
  await page.goto("/settings/security");
  await page.getByLabel("Your password, to link a provider").fill(MEMBER_PASSWORD);
  await page.getByRole("button", { name: `Link ${OIDC_STUB_LABEL}` }).click();

  await expect(page).toHaveURL(/\/settings\/security/);
  await expect(page.getByTestId("toast").filter({ hasText: "Linking did not work. Try again." })).toHaveCount(1);
});

test("an invitee whose domain is not open accepts with a provider, without the link", async ({ page }) => {
  const email = fresh("invitee");
  await invitation({ email, boards: [{ project: PROJECT_ID, relation: "member", addedBy: ADMIN_ID }] });
  await stubSignsIn({ email, name: "Invited Person" });

  await page.goto("/login");
  await page.getByRole("button", { name: `Continue with ${OIDC_STUB_LABEL}` }).click();
  await expect(page).toHaveURL(/\/invite\/sso$/);
  const username = `invitee${randomBytes(3).toString("hex")}`;
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Full name").fill("Invited Person");
  await page.getByRole("button", { name: "Create my account" }).click();
  await expect(page).toHaveURL(/\/projects/);

  const account = await (await db()).collection("users").findOne({ email });
  expect(account).toMatchObject({ username, role: "member" });
  expect(await (await db()).collection("grants").countDocuments({ subject: account?._id, object: PROJECT_ID })).toBe(1);
});

test("a board owner's invitation leaves an administrator's lapsed one for the administrator", async ({ page }) => {
  const email = fresh("lapsed");
  await invitation({ email, role: "admin", expiresAt: new Date(Date.now() - 60 * 1000) });

  await signIn(page, "owner");
  await page.goto(`/projects/${PROJECT_KEY}/settings`);
  const card = page.locator("section").filter({ hasText: "Invite by email" });
  await card.getByLabel("Email to invite").fill(email);
  await card.getByRole("button", { name: "Invite", exact: true }).click();

  await expect(alertOn(page)).toContainText(`${email} already has an invitation from admin`);
  const held = await (await db()).collection("invitations").find({ email }).toArray();
  expect(held.map((i) => [i.status, i.role])).toEqual([["pending", "admin"]]);
});

test("a resend drops a board whose adder can no longer grant it", async ({ page }) => {
  const email = fresh("resent");
  await invitation({
    email,
    boards: [{ project: PROJECT_ID, relation: "member", addedBy: OWNER_ID }],
  });
  await (await db())
    .collection("grants")
    .updateOne({ subject: OWNER_ID, objectType: "project", object: PROJECT_ID }, { $set: { relation: "member" } });

  await signIn(page, "admin");
  await page.goto("/settings/users");
  await page.getByRole("button", { name: `Resend the invitation for ${email}` }).click();

  await expect(page.getByTestId("toast").filter({ hasText: `Invitation sent again to ${email}` })).toHaveCount(1);
  const after = await (await db()).collection("invitations").findOne({ email, status: "pending" });
  expect(after?.boards).toEqual([]);
});
