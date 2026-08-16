import { test, expect, type Page } from "@playwright/test";
import { createHash, randomBytes } from "crypto";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, MEMBER_ID, MEMBER_PASSWORD, MEMBER_USERNAME, seed } from "./seed";

/**
 * BP-281, slice 3. The reset itself.
 *
 * CI has no mail server, so the link is planted in the database exactly as a delivered email would
 * leave it — a row holding the hash, and the raw token in hand. That is not a shortcut around the
 * thing under test: what has to be proven here is that a link works once, stops working after the
 * hour, and cannot be used twice. Delivery is the previous slice's problem and was driven against
 * a real SMTP server locally.
 */

const HOUR = 60 * 60 * 1000;

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

/** What the app would have stored when it emailed somebody a link. */
async function plantLink(overrides: Record<string, unknown> = {}) {
  const token = `cpr_${randomBytes(32).toString("hex")}`;
  const handle = await db();
  await handle.collection("passwordresettokens").insertOne({
    user: MEMBER_ID,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + HOUR),
    usedAt: null,
    createdAt: new Date(),
    ...overrides,
  });
  return token;
}

async function setNewPassword(page: Page, token: string, password: string) {
  await page.goto(`/reset?token=${token}`);
  // exact, because "New password" is a substring of "Confirm new password"
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password").fill(password);
  await page.getByRole("button", { name: "Set the password" }).click();
}

async function signIn(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
}

test.beforeEach(async () => {
  await seed();
  const handle = await db();
  await handle.collection("passwordresettokens").deleteMany({});
  await handle.collection("instanceauditlogs").deleteMany({});
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("a link sets a new password, and the account signs in with it", async ({ page }) => {
  const token = await plantLink();
  await setNewPassword(page, token, "chosen-after-the-email");

  await expect(page.getByText("Your password is set")).toBeVisible();

  await signIn(page, MEMBER_USERNAME, "chosen-after-the-email");
  await expect(page).toHaveURL(/\/projects/);

  const rows = await (await db()).collection("instanceauditlogs").find({}).toArray();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ action: "password_reset_completed", target: MEMBER_USERNAME });
});

test("the old password stops working once the link is used", async ({ page }) => {
  const token = await plantLink();
  await setNewPassword(page, token, "chosen-after-the-email");
  await expect(page.getByText("Your password is set")).toBeVisible();

  await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);

  await expect(page.getByText("Invalid credentials")).toBeVisible();
});

// The headline criterion. A link that still works after it has been spent is a spare key left in
// an inbox — and inboxes are exactly what gets read by somebody else later.
test("a link works once and never again", async ({ page }) => {
  const token = await plantLink();
  await setNewPassword(page, token, "the-first-password");
  await expect(page.getByText("Your password is set")).toBeVisible();

  await setNewPassword(page, token, "a-second-password-attempt");

  await expect(page.getByText("This link has already been used. Ask for a new one.")).toBeVisible();
  // And the password really is the first one, not the second
  await signIn(page, MEMBER_USERNAME, "the-first-password");
  await expect(page).toHaveURL(/\/projects/);
});

test("a link stops working after its hour", async ({ page }) => {
  const token = await plantLink({ expiresAt: new Date(Date.now() - 60_000) });

  await setNewPassword(page, token, "too-late-for-this");

  await expect(page.getByText("This link has expired. Ask for a new one.")).toBeVisible();
  await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
  await expect(page).toHaveURL(/\/projects/);
});

test("a token nobody issued is refused", async ({ page }) => {
  await setNewPassword(page, `cpr_${randomBytes(32).toString("hex")}`, "not-my-account");

  await expect(page.getByText("This link is not valid. Ask for a new one.")).toBeVisible();
});

// Whoever knew the old password may be reading over the account's shoulder right now; that is
// usually why somebody resets one
test("the reset ends a session the account already had", async ({ browser }) => {
  const memberContext = await browser.newContext();
  const resetContext = await browser.newContext();
  try {
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, MEMBER_USERNAME, MEMBER_PASSWORD);
    await expect(memberPage).toHaveURL(/\/projects/);

    const token = await plantLink();
    await setNewPassword(await resetContext.newPage(), token, "chosen-after-the-email");

    await memberPage.reload();
    await expect(memberPage).toHaveURL(/\/login/);
  } finally {
    await memberContext.close();
    await resetContext.close();
  }
});

test("the sign-in screen offers the way in when a password is forgotten", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("link", { name: "Forgot your password?" }).click();

  await expect(page).toHaveURL(/\/forgot/);
  await expect(page.getByRole("heading", { name: "Forgot your password?" })).toBeVisible();
});

// CI has no mail server, which is the state a self-hosted instance starts in. Somebody left
// waiting for a message that was never coming is the failure this wording exists to prevent.
test("an instance with no mail server says so instead of promising a link", async ({ page }) => {
  await page.goto("/forgot");
  await page.getByLabel("Username or email").fill(MEMBER_USERNAME);
  await page.getByRole("button", { name: "Send the link" }).click();

  await expect(page.getByText(/cannot send email/)).toBeVisible();
  await expect(page.getByText(/a link is on its way/)).toBeHidden();
});

// Not about the reset, but it is what this slice tripped over and nothing else guards it. The
// throttle records a failure with an aggregation pipeline, which mongoose 9 refuses without an
// option nobody had passed — so every wrong password answered 500 and the counter stayed empty.
// The unit tests use an in-memory stand-in for that model and cannot see it, and the sign-in
// screen prints "Invalid credentials" for any failed response, so a 500 looked exactly like a
// refusal on screen. Only the status tells them apart.
test("a wrong password is refused, and the refusal is counted", async ({ request }) => {
  const wrong = () =>
    request.post("/api/auth/login", {
      headers: { "Sec-Fetch-Site": "same-origin" },
      data: { username: MEMBER_USERNAME, password: "not-the-password" },
    });

  expect((await wrong()).status()).toBe(401);

  const handle = await db();
  const counters = await handle.collection("ratelimits").find({}).toArray();
  expect(counters.length).toBeGreaterThan(0);
  expect(counters.some((c) => (c.count as number) > 0)).toBe(true);
});

test("a reset link with no token explains itself rather than failing oddly", async ({ page }) => {
  await page.goto("/reset");

  await expect(page.getByText("This link is incomplete")).toBeVisible();
});
