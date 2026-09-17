import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, PROJECT_NAME, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-471, last item. An instance admin governs each project's PM agent from /settings/agents: on or
 * off, a lock the project cannot lift, the model and the daily turn cap. Every spec that relied on
 * those settings wrote them into Mongo itself, so the row that sets them had never been clicked.
 * Each change here is made on that row and read back twice: from the database, and from what the
 * project's own PM settings then do.
 */

async function storedPm(): Promise<Record<string, unknown>> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    const project = await mongoose.connection.db!.collection("projects").findOne({ _id: PROJECT_ID });
    return (project?.pm ?? {}) as Record<string, unknown>;
  } finally {
    await mongoose.disconnect();
  }
}

const row = (page: Page) => page.getByRole("row").filter({ hasText: PROJECT_NAME });

async function openAgents(page: Page) {
  await page.goto("/settings/agents");
  await expect(row(page).getByRole("button", { name: /^(On|Off)$/ })).toBeVisible();
}

/** The project's own "Run a review now", which answers with why the agent cannot run */
async function reviewRefusal(page: Page): Promise<string> {
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=pm`);
  const answered = page.waitForResponse((r) => r.url().endsWith("/pm/review") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Run a review now" }).click();
  const response = await answered;
  expect(response.status()).toBe(409);
  return (await response.json()).error;
}

test.beforeEach(seed);

test("switching a project's agent off on its row stops it, and on again brings it back", async ({ page }) => {
  await signIn(page);
  await openAgents(page);

  await row(page).getByRole("button", { name: "On", exact: true }).click();
  await expect(row(page).getByRole("button", { name: "Off", exact: true })).toBeVisible();
  await expect.poll(async () => (await storedPm()).enabled).toBe(false);
  expect(await reviewRefusal(page)).toBe("PM agent is not enabled for this project");

  await openAgents(page);
  await row(page).getByRole("button", { name: "Off", exact: true }).click();
  await expect(row(page).getByRole("button", { name: "On", exact: true })).toBeVisible();
  await expect.poll(async () => (await storedPm()).enabled).toBe(true);
});

test("the lock on a project's row holds its agent off, whatever the project's own switch says", async ({ page }) => {
  await signIn(page);
  await openAgents(page);

  await row(page).getByRole("button", { name: "Lock", exact: true }).click();
  await expect(row(page).getByRole("button", { name: "Locked", exact: true })).toBeVisible();
  // The on/off switch is not the project's to flip while it is locked
  await expect(row(page).getByRole("button", { name: /^(On|Off)$/ })).toBeDisabled();
  expect(await storedPm()).toMatchObject({ lockedByInstance: true, enabled: true });
  expect(await reviewRefusal(page)).toBe("PM agent is disabled for this project by an instance admin");

  await openAgents(page);
  await row(page).getByRole("button", { name: "Locked", exact: true }).click();
  await expect(row(page).getByRole("button", { name: "Lock", exact: true })).toBeVisible();
  await expect.poll(async () => (await storedPm()).lockedByInstance).toBe(false);
});

test("a model and a turn cap typed into the row are stored and shown again after a reload", async ({ page }) => {
  await signIn(page);
  await openAgents(page);
  const model = page.getByLabel(`PM model for ${PROJECT_KEY} — ${PROJECT_NAME}`);
  const cap = page.getByLabel(`Daily turn cap for ${PROJECT_KEY} — ${PROJECT_NAME}`);

  await model.fill("e2e/governed-model");
  await model.blur();
  await cap.fill("7");
  await cap.blur();

  await expect.poll(async () => storedPm()).toMatchObject({ model: "e2e/governed-model", dailyTurnCap: 7 });
  await page.reload();
  await expect(page.getByLabel(`PM model for ${PROJECT_KEY} — ${PROJECT_NAME}`)).toHaveValue("e2e/governed-model");
  await expect(page.getByLabel(`Daily turn cap for ${PROJECT_KEY} — ${PROJECT_NAME}`)).toHaveValue("7");
});
