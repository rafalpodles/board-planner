import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  MEMBER_ID,
  OWNER_ID,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  seed,
} from "./seed";
import { signIn } from "./session";

/** BP-765. Deleting a user must not leave a board nobody but an instance admin can manage. */

const DELETED_CO_OWNER_ID = new mongoose.Types.ObjectId("e2e00000000000000000a765");

async function grants() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle.collection("grants");
}

async function grantsOf(subject: mongoose.Types.ObjectId) {
  return (await grants()).find({ subject }).toArray();
}

async function addOwner(subject: mongoose.Types.ObjectId) {
  const now = new Date();
  await (await grants()).updateOne(
    { subject, objectType: "project", object: PROJECT_ID },
    {
      $set: { relation: "owner", updatedAt: now },
      $setOnInsert: { createdBy: ADMIN_ID, createdAt: now },
    },
    { upsert: true }
  );
}

async function confirmDelete(page: Page, fullName: string, userId: mongoose.Types.ObjectId) {
  await page.goto("/settings/users");
  await page.getByText(fullName, { exact: true }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete User" });
  await expect(dialog.getByText(`Are you sure you want to delete "${fullName}"?`)).toBeVisible();

  const answered = page.waitForResponse(
    (res) => res.url().includes(`/api/users/${userId}`) && res.request().method() === "DELETE"
  );
  await dialog.getByRole("button", { name: "Delete User", exact: true }).click();
  return { dialog, response: await answered };
}

test.beforeEach(seed);

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("the only owner of a board is refused, and the dialog says which board", async ({ page }) => {
  await signIn(page, "admin");

  const { dialog, response } = await confirmDelete(page, "E2E Owner", OWNER_ID);

  expect(response.status(), await response.text()).toBe(409);
  await expect(dialog.getByRole("alert")).toHaveText(
    `owner is the only owner of ${PROJECT_NAME} (${PROJECT_KEY}). Make someone else an owner there before deleting this account.`
  );
  await expect(dialog).toBeVisible();

  await page.reload();
  await expect(page.getByText("@owner")).toBeVisible();
  expect(await grantsOf(OWNER_ID)).toHaveLength(1);
});

test("an owner row left behind by an earlier deletion does not count as a second owner", async ({
  page,
}) => {
  await addOwner(DELETED_CO_OWNER_ID);
  await signIn(page, "admin");

  const { dialog, response } = await confirmDelete(page, "E2E Owner", OWNER_ID);

  expect(response.status(), await response.text()).toBe(409);
  await expect(dialog.getByRole("alert")).toContainText(`${PROJECT_NAME} (${PROJECT_KEY})`);
  expect(await grantsOf(OWNER_ID)).toHaveLength(1);
});

test("a member is deleted, and takes their grants with them", async ({ page }) => {
  expect(await grantsOf(MEMBER_ID)).not.toHaveLength(0);
  await signIn(page, "admin");

  const { dialog, response } = await confirmDelete(page, "E2E Member", MEMBER_ID);

  expect(response.status(), await response.text()).toBe(200);
  await expect(dialog).toBeHidden();
  await expect(page.getByText("@member")).toHaveCount(0);
  expect(await grantsOf(MEMBER_ID)).toHaveLength(0);
  expect(await grantsOf(OWNER_ID)).toHaveLength(1);
});

test("an owner who shares the board with another owner is deleted", async ({ page }) => {
  await addOwner(MEMBER_ID);
  await signIn(page, "admin");

  const { dialog, response } = await confirmDelete(page, "E2E Owner", OWNER_ID);

  expect(response.status(), await response.text()).toBe(200);
  await expect(dialog).toBeHidden();
  await expect(page.getByText("@owner")).toHaveCount(0);
  expect(await grantsOf(OWNER_ID)).toHaveLength(0);
  const remaining = await (await grants()).find({ object: PROJECT_ID, relation: "owner" }).toArray();
  expect(remaining.map((g) => String(g.subject))).toEqual([String(MEMBER_ID)]);
});
