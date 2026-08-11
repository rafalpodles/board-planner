import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  ADMIN_ID,
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  E2E_MONGODB_URI,
  HELD_TASK_ID,
  PROJECT_ID,
  PROJECT_KEY,
  SIBLING_TASK_NUMBER,
  seed,
} from "./seed";

/**
 * BP-254, the rendering half. A task key written in prose becomes a link to that task, and nothing
 * is stored as a link — the text keeps saying `BP-12`.
 *
 * That choice is why the former key matters here: this board renamed itself from CP to BP, so
 * everything written before that still says CP and would otherwise be a dead reference. A stored
 * URL would have needed migrating through every description and comment instead.
 */

const TASK_URL = `/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function addComment(body: string) {
  const handle = await db();
  await handle.collection("comments").insertOne({
    task: HELD_TASK_ID,
    author: ADMIN_ID,
    body,
    reactions: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN_USERNAME);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);
}

test.beforeEach(async () => {
  await seed();
  const handle = await db();
  await handle.collection("comments").deleteMany({});
  await handle
    .collection("projects")
    .updateOne({ _id: PROJECT_ID }, { $set: { formerKeys: ["CP"] } });
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("a key written in a description links to that task, and reaches it", async ({ page }) => {
  const handle = await db();
  await handle
    .collection("tasks")
    .updateOne(
      { _id: HELD_TASK_ID },
      { $set: { description: `Blocked by ${PROJECT_KEY}-${SIBLING_TASK_NUMBER} until it lands.` } }
    );

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

  const link = page.getByRole("link", { name: `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}` });
  await expect(link).toBeVisible();

  // The link has to actually arrive, not merely look like one
  await link.click();
  await expect(page).toHaveURL(new RegExp(`${TASK_URL}$`));
});

test("a key from before the board was renamed still reaches the task", async ({ page }) => {
  await addComment(`Originally raised as CP-${SIBLING_TASK_NUMBER}.`);

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

  const link = page.getByRole("link", { name: `CP-${SIBLING_TASK_NUMBER}` });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", TASK_URL);
});

test("a key inside code stays text, and another project's key is left alone", async ({ page }) => {
  await addComment(
    `Branch prefix is \`${PROJECT_KEY}-9\`, and this waits on ACME-4.\n\n` +
      "```\ngit checkout bp-9/slug\n```"
  );

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

  await expect(page.getByText(`${PROJECT_KEY}-9`).first()).toBeVisible();
  await expect(page.getByRole("link", { name: `${PROJECT_KEY}-9` })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "ACME-4" })).toHaveCount(0);
});

test.describe("picking a task from the list", () => {
  test("typing the board key offers tasks, and Enter puts the key in the text", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

    const box = page.getByPlaceholder(/comment/i).first();
    await box.fill(`blocked by ${PROJECT_KEY}-`);

    const list = page.getByRole("listbox");
    await expect(list).toBeVisible();
    await expect(list.getByRole("option").first()).toBeVisible();
    // The ticket asks for at most ten, and the seeded board has fewer
    expect(await list.getByRole("option").count()).toBeLessThanOrEqual(10);

    const first = (await list.getByRole("option").first().innerText()).split("\n")[0].trim();
    await box.press("Enter");

    // Plain text, not a markdown link — that is the whole of approach (A)
    await expect(box).toHaveValue(`blocked by ${first} `);
  });

  test("arrows move the selection and Escape puts the list away", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

    const box = page.getByPlaceholder(/comment/i).first();
    await box.fill(`see ${PROJECT_KEY}-`);
    const list = page.getByRole("listbox");
    await expect(list).toBeVisible();

    await box.press("ArrowDown");
    await expect(list.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");

    await box.press("Escape");
    await expect(list).toBeHidden();
    // Escape dismisses the list, it does not edit what was written
    await expect(box).toHaveValue(`see ${PROJECT_KEY}-`);
  });

  test("offers nothing for another project's key", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

    await page.getByPlaceholder(/comment/i).first().fill("blocked by ACME-");

    await expect(page.getByRole("listbox")).toBeHidden();
  });
});

// Pasting is the same feature as picking from a list, which is the point of storing plain text
test("a key typed into a new comment is a link once posted", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

  await page
    .getByPlaceholder(/comment/i)
    .first()
    .fill(`See ${PROJECT_KEY}-${SIBLING_TASK_NUMBER} for the rest`);
  await page.getByRole("button", { name: /^(Comment|Post|Add comment)$/ }).first().click();

  await expect(
    page.getByRole("link", { name: `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}` })
  ).toBeVisible();
});
