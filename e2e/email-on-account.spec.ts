import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH } from "./api";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  E2E_MONGODB_URI,
  MEMBER_ID,
  MEMBER_USERNAME,
  seed,
} from "./seed";

/**
 * BP-281, slice 2. A password reset by email needs an address to send to, and an account had no
 * way of acquiring one except its owner logging in and typing it — which is the one thing somebody
 * who has lost their password cannot do.
 *
 * The uniqueness of that address is asserted here rather than trusted: the index the schema
 * declared until this slice used `$ne` in a partial filter, which MongoDB refuses and Mongoose
 * swallows, so two accounts could hold one address and the reset lookup had no single answer.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function signInAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN_USERNAME);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);
}

async function createUser(page: Page, username: string, email: string) {
  await page.getByRole("button", { name: "New User" }).click();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill("a-starting-password");
  await page.getByLabel("Full Name").fill(username.toUpperCase());
  await page.getByLabel("Email (optional)").fill(email);
  await page.getByRole("button", { name: "Create User" }).click();
}

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("an admin gives a new account an address, and it is stored as typed but tidied", async ({
  page,
}) => {
  await signInAsAdmin(page);
  await page.goto("/settings/users");
  await createUser(page, "nowak", "  Anna.Nowak@Example.COM ");

  await expect(page.getByText("@nowak", { exact: true })).toBeVisible();

  // Read from the database, not from the screen: the screen never shows the stored form, and a
  // reset lookup will compare against exactly this
  const handle = await db();
  const created = await handle.collection("users").findOne({ username: "nowak" });
  expect(created?.email).toBe("anna.nowak@example.com");
});

test("two accounts cannot hold one address", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/settings/users");

  // The app builds its indexes in the background on first use; this waits for the one under test
  // rather than racing it, and fails loudly if it never appears
  await expect
    .poll(
      async () => {
        const handle = await db();
        const indexes = await handle.collection("users").indexes();
        return indexes.some((i) => i.key?.email === 1 && i.unique);
      },
      { message: "the unique index on email was never built" }
    )
    .toBe(true);

  await createUser(page, "nowak", "anna.nowak@example.com");
  await expect(page.getByText("@nowak", { exact: true })).toBeVisible();

  await createUser(page, "kowalski", "anna.nowak@example.com");

  // Named for the field that actually collided — "Username already exists" would send the admin to
  // correct the one thing that was fine
  await expect(page.getByText("That email is already on another account")).toBeVisible();
  const handle = await db();
  expect(await handle.collection("users").countDocuments({ username: "kowalski" })).toBe(0);
});

test("many accounts may have no address at all", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/settings/users");

  await createUser(page, "first", "");
  await expect(page.getByText("@first", { exact: true })).toBeVisible();
  await createUser(page, "second", "");
  await expect(page.getByText("@second", { exact: true })).toBeVisible();

  // The seeded accounts have none either, so the partial filter has to tolerate a crowd of them
  const handle = await db();
  expect(await handle.collection("users").countDocuments({ email: "" })).toBeGreaterThan(1);
});

test("an admin can give an existing account an address", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/settings/users");
  await page.getByText(`@${MEMBER_USERNAME}`, { exact: true }).first().click();

  await page.getByLabel("Email", { exact: true }).fill("member@example.com");
  await Promise.all([
    page.waitForResponse(
      (r) => /\/api\/users\/\w+$/.test(new URL(r.url()).pathname) && r.request().method() === "PUT"
    ),
    page.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  await expect(page.getByText("User updated")).toBeVisible();

  const handle = await db();
  const member = await handle.collection("users").findOne({ _id: MEMBER_ID });
  expect(member?.email).toBe("member@example.com");
});

test("an address that could never receive anything is refused", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/settings/users");
  await page.getByText(`@${MEMBER_USERNAME}`, { exact: true }).first().click();

  // type="email" would let the browser refuse this before the server ever sees it, so the check
  // goes through the API — the server is what a reset will depend on
  const response = await page.request.put(`/api/users/${MEMBER_ID.toString()}`, {
    headers: { "Sec-Fetch-Site": "same-origin" },
    data: { email: "not-an-address" },
  });
  expect(response.status()).toBe(400);
});

// Whoever writes this field chooses where a reset link lands, so it is gated like the password
test("an admin API token cannot change an address", async ({ request }) => {
  const response = await request.put(`/api/users/${MEMBER_ID.toString()}`, {
    headers: ADMIN_AUTH,
    data: { email: "attacker@example.com" },
  });

  expect(response.status()).toBe(403);
  const handle = await db();
  const member = await handle.collection("users").findOne({ _id: MEMBER_ID });
  expect(member?.email).not.toBe("attacker@example.com");
});

// CI has no mail server, which is the state most self-hosted instances start in. The screen has to
// say so rather than offer a button that silently does nothing.
test("the email screen says plainly when no mail server is configured", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/settings/email");

  await expect(page.getByText("No mail server is configured.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send a test message" })).toBeDisabled();
});
