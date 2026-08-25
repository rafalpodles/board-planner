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
import { signIn as arriveSignedIn } from "./session";

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

const signInAsAdmin = arriveSignedIn;

async function createUser(page: Page, username: string, email: string) {
  await page.getByRole("button", { name: "New User" }).click();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill("a-starting-password");
  await page.getByLabel("Full Name").fill(username.toUpperCase());
  await page.getByRole("dialog").getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Create User" }).click();
}

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("an admin gives a new account an address, and it is stored trimmed and lower-cased", async ({
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

  // Named, not counted: the seeded accounts already have no address, so a count would be satisfied
  // before this test did anything at all
  const handle = await db();
  const withoutAddress = await handle
    .collection("users")
    .find({ username: { $in: ["first", "second"] }, email: "" })
    .toArray();
  expect(withoutAddress).toHaveLength(2);
});

test("an admin can give an existing account an address", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/settings/users");
  await page.getByText(`@${MEMBER_USERNAME}`, { exact: true }).first().click();

  await page.getByRole("dialog").getByLabel("Email").fill("member@example.com");
  await Promise.all([
    page.waitForResponse(
      (r) => /\/api\/users\/\w+$/.test(new URL(r.url()).pathname) && r.request().method() === "PUT"
    ),
    page.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  await expect(page.getByText("Saved")).toBeVisible();

  const handle = await db();
  const member = await handle.collection("users").findOne({ _id: MEMBER_ID });
  expect(member?.email).toBe("member@example.com");
});

// What the admin is left looking at, not merely what the server answers: the refusal has to land
// beside the field, because a toast is gone in three seconds and the bad address stays on screen
test("a rejected address is reported next to the field", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/settings/users");
  await page.getByText(`@${MEMBER_USERNAME}`, { exact: true }).first().click();

  const dialog = page.getByRole("dialog");
  // Passes the browser's own type="email" check, so the server's answer is what this exercises.
  // Note `someone@nodomain` would NOT do: a single-label domain is deliberately allowed, because
  // an intranet deployment has addresses like admin@intranet and nothing else.
  await dialog.getByLabel("Email").fill("someone@corp..com");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();

  await expect(dialog.getByText("That does not look like an email address")).toBeVisible();
  // Still open, still holding what was typed — nothing was saved behind the admin's back
  await expect(dialog.getByLabel("Email")).toHaveValue("someone@corp..com");

  const handle = await db();
  const member = await handle.collection("users").findOne({ _id: MEMBER_ID });
  expect(member?.email).toBe("");
});

test("an address already on another account is reported next to the field", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/settings/users");
  await createUser(page, "nowak", "anna.nowak@example.com");
  await expect(page.getByText("@nowak", { exact: true })).toBeVisible();

  await page.getByText(`@${MEMBER_USERNAME}`, { exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email").fill("anna.nowak@example.com");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();

  await expect(dialog.getByText("That email is already on another account")).toBeVisible();
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
  // Stated rather than assumed, in the same shape as reset-by-email.spec.ts: this asserts the
  // unconfigured state, so anybody who gives the run an SMTP_HOST would otherwise get a red here
  // in a file they never touched.
  test.skip(!!process.env.SMTP_HOST, "this asserts the unconfigured state");

  await signInAsAdmin(page);
  await page.goto("/settings/email");

  await expect(page.getByText("No mail server is configured.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send a test message" })).toBeDisabled();
});
