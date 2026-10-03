import { test, expect, type Browser } from "@playwright/test";
import { randomBytes } from "crypto";
import mongoose from "mongoose";
import {
  OIDC_STUB_ADMIN_GROUP,
  OIDC_STUB_LABEL,
  OIDC_STUB_URL,
  PASSWORDLESS_BASE_URL,
  RUN_PASSWORDLESS_SERVER,
} from "../playwright.config";
import { ADMIN_ID, E2E_MONGODB_URI, MEMBER_ID, MEMBER_USERNAME, seed } from "./seed";

/**
 * BP-833. With OIDC_ADMIN_GROUP set — on the password-sign-in-off server, where every sign-in is
 * through the provider — the provider's groups decide at each sign-in who administers.
 */

const SKIP_REASON = "needs the password-sign-in-off app server — set E2E_PASSWORDLESS_SERVER=1 (see playwright.config.ts)";
test.skip(!RUN_PASSWORDLESS_SERVER, SKIP_REASON);

const at = (path: string) => `${PASSWORDLESS_BASE_URL}${path}`;

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

const roleOf = async (id: typeof MEMBER_ID) => (await (await db()).collection("users").findOne({ _id: id }))?.role;

/** The member signs in through the provider, in the given groups, and looks at Settings. */
async function memberSignsIn(browser: Browser, groups: string[] | undefined) {
  const email = `member-${randomBytes(4).toString("hex")}@example.com`;
  await (await db()).collection("users").updateOne({ _id: MEMBER_ID }, { $set: { email, emailVerifiedAt: new Date() } });
  await (await db()).collection("identities").deleteMany({ user: MEMBER_ID });
  const res = await fetch(`${OIDC_STUB_URL}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sub: `sub-${randomBytes(4).toString("hex")}`, email, email_verified: true, ...(groups ? { groups } : {}) }),
  });
  expect(res.ok, "the OIDC stub refused its script").toBe(true);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(at("/login"));
  await page.getByRole("button", { name: `Continue with ${OIDC_STUB_LABEL}` }).click();
  await expect(page).toHaveURL(/\/projects/);
  await page.goto(at("/settings/profile"));
  await expect(page.getByRole("link", { name: "Profile" })).toBeVisible();
  return { context, page };
}

const usersLink = (page: import("@playwright/test").Page) => page.getByRole("link", { name: "Users", exact: true });

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("a sign-in in the admin group makes the account an admin, and one outside it takes that back", async ({ browser }) => {
  const promoted = await memberSignsIn(browser, ["staff", OIDC_STUB_ADMIN_GROUP]);
  await expect(usersLink(promoted.page)).toBeVisible();
  expect(await roleOf(MEMBER_ID)).toBe("admin");
  await promoted.context.close();

  const demoted = await memberSignsIn(browser, ["staff"]);
  await expect(usersLink(demoted.page)).toHaveCount(0);
  expect(await roleOf(MEMBER_ID)).toBe("member");
  await demoted.context.close();

  const auditDetails = async () =>
    (
      await (await db())
        .collection("instanceauditlogs")
        .find({ action: "user_role_changed", target: MEMBER_USERNAME })
        .sort({ createdAt: 1 })
        .toArray()
    ).map((row) => row.detail);
  await expect
    .poll(auditDetails)
    .toEqual([
      `member → admin, in the identity provider's group ${OIDC_STUB_ADMIN_GROUP}`,
      `admin → member, no longer in the identity provider's group ${OIDC_STUB_ADMIN_GROUP}`,
    ]);
});

test("the last admin stays one, in the group or not", async ({ browser }) => {
  await (await db()).collection("users").updateOne({ _id: ADMIN_ID }, { $set: { role: "member" } });
  await (await db()).collection("users").updateOne({ _id: MEMBER_ID }, { $set: { role: "admin" } });

  const signedIn = await memberSignsIn(browser, undefined);
  await expect(usersLink(signedIn.page)).toBeVisible();
  expect(await roleOf(MEMBER_ID)).toBe("admin");
  await signedIn.context.close();
});
