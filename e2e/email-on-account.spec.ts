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

  const handle = await db();
  const created = await handle.collection("users").findOne({ username: "nowak" });
  expect(created?.email).toBe("anna.nowak@example.com");
});

test("two accounts cannot hold one address", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/settings/users");

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

test("a rejected address is reported next to the field", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/settings/users");
  await page.getByText(`@${MEMBER_USERNAME}`, { exact: true }).first().click();

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email").fill("someone@corp..com");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();

  await expect(dialog.getByText("That does not look like an email address")).toBeVisible();
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

test("the email screen says plainly when no mail server is configured", async ({ page }) => {
  test.skip(!!process.env.SMTP_HOST, "this asserts the unconfigured state");

  await signInAsAdmin(page);
  await page.goto("/settings/email");

  await expect(page.getByText("No mail server is configured.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send a test message" })).toBeDisabled();
});
