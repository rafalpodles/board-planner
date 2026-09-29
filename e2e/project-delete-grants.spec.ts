import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  MEMBER_ID,
  OTHER_PROJECT_ID,
  OTHER_PROJECT_NAME,
  OWNER_ID,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  seed,
  seedSearchCorpus,
} from "./seed";
import { signIn } from "./session";

/** BP-790. Deleting a board takes its grants with it, and leaves every other board's alone. */

async function grants() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle.collection("grants");
}

async function grantsOn(object: mongoose.Types.ObjectId) {
  const rows = await (await grants()).find({ objectType: "project", object }).toArray();
  return rows.map((g) => `${g.subject}:${g.relation}`).sort();
}

test.beforeEach(async () => {
  await seed();
  await seedSearchCorpus();
  const now = new Date();
  await (await grants()).insertMany(
    [
      { subject: OWNER_ID, relation: "owner" },
      { subject: MEMBER_ID, relation: "member" },
    ].map((g) => ({
      ...g,
      objectType: "project",
      object: OTHER_PROJECT_ID,
      createdBy: ADMIN_ID,
      createdAt: now,
      updatedAt: now,
    }))
  );
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("an owner deletes a board, and its grants go while another board's stay", async ({ page }) => {
  const control = [`${MEMBER_ID}:member`, `${OWNER_ID}:owner`];
  expect(await grantsOn(PROJECT_ID)).toEqual(control);
  expect(await grantsOn(OTHER_PROJECT_ID)).toEqual(control);

  await signIn(page, "owner");
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=general`);
  await expect(page.getByLabel("Project name")).toHaveValue(PROJECT_NAME);

  const deleted = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/projects/${PROJECT_KEY}` && r.request().method() === "DELETE"
  );
  await page.getByRole("button", { name: "Delete project..." }).click();
  await expect(page.getByRole("dialog")).toContainText(`Delete "${PROJECT_NAME}"?`);
  await page.getByRole("button", { name: "Delete project", exact: true }).click();
  const response = await deleted;
  expect(response.status(), await response.text()).toBe(200);
  await expect(page).toHaveURL(/\/projects$/);

  expect(await grantsOn(PROJECT_ID)).toEqual([]);
  expect(await grantsOn(OTHER_PROJECT_ID)).toEqual(control);

  await page.reload();
  await expect(
    page.getByRole("complementary").getByRole("link", { name: new RegExp(OTHER_PROJECT_NAME) })
  ).toBeVisible();
});
