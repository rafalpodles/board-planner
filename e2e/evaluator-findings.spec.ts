import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  E2E_MONGODB_URI,
  OUTSIDER_PASSWORD,
  OUTSIDER_USERNAME,
  PROJECT_KEY,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  seed,
  seedAssignmentOutsider,
} from "./seed";
import { signIn, signInThroughForm } from "./session";

/**
 * Four things an agent-driven evaluation of the product (`trawler`) hit independently, each
 * reproduced by a second session that was given only the steps. Every evaluator that opened a
 * task's History after editing it concluded the history recorded nothing; a board you have no
 * grant to looked like an outage; a step placed in an agent vanished when the page was left
 * unsaved; and the new-task form called acceptance criteria a "Checklist".
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

function write(page: Page, method: string, urlPart: string) {
  return page.waitForResponse(
    (res) => res.request().method() === method && res.url().includes(urlPart)
  );
}

test.beforeEach(seed);

test("an edit appears in History without a reload, and so does a description change", async ({
  page,
}) => {
  await signIn(page);
  // Armed before the navigation: both tab panels mount with the page, so the history is read then,
  // not when its tab is clicked
  const historyLoaded = page.waitForResponse((r) => r.url().includes("/activity") && r.ok());
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
  await expect(page.getByLabel("Task title")).toBeVisible();
  await historyLoaded;
  await page.getByRole("tab", { name: /^History/ }).click();
  const history = page.locator("#task-panel-history");

  await test.step("a title change is listed as soon as it is saved", async () => {
    const saved = write(page, "PUT", `/tasks/${SIBLING_TASK_ID}`);
    await page.getByLabel("Task title").fill("Renamed with History open");
    expect((await saved).status()).toBe(200);
    // Short on purpose: the panel does not poll, so only a refetch caused by the save can pass this
    await expect(history).toContainText("changed title from", { timeout: 3_000 });
  });

  await test.step("a description change is recorded at all, and listed the same way", async () => {
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const field = page.locator("section").filter({ hasText: "Description" }).locator("textarea");
    await field.fill("What this task says now");
    const saved = write(page, "PUT", `/tasks/${SIBLING_TASK_ID}`);
    await field.blur();
    expect((await saved).status()).toBe(200);
    await expect(history).toContainText(/edited the description|added a description/, { timeout: 3_000 });
  });
});

test("a board with no grant says so on every screen of it, and offers no Retry", async ({
  page,
}) => {
  await seedAssignmentOutsider();
  await signInThroughForm(page, OUTSIDER_USERNAME, OUTSIDER_PASSWORD);

  for (const path of ["", "/sprints", "/settings"]) {
    await test.step(`/projects/${PROJECT_KEY}${path}`, async () => {
      await page.goto(`/projects/${PROJECT_KEY}${path}`);
      const alert = page.getByRole("alert").filter({ hasText: "You do not have access to this board" });
      await expect(alert).toBeVisible();
      // Reading the board again returns the same refusal, so a Retry beside it is a lie
      await expect(alert.getByRole("button", { name: "Retry" })).toHaveCount(0);
    });
  }
});

// As an admin: to anybody without a grant the server deliberately answers a missing board and a
// refused one the same way, so only a reader who could see it may be told it is not there
test("a board that does not exist gets a different sentence from a refused one", async ({ page }) => {
  await signIn(page);
  await page.goto("/projects/NOSUCHKEY/settings");
  // Filtered: Next keeps an empty route announcer with the same role on every page
  const alert = page.getByRole("alert").filter({ hasText: "There is no board here" });
  await expect(alert).toBeVisible();
  await expect(alert).not.toContainText("do not have access");
});

test("a failure that is not a refusal still offers Retry, and Retry loads the board", async ({
  page,
}) => {
  await signIn(page);
  let refuse = true;
  await page.route(new RegExp(`/api/projects/${PROJECT_KEY}$`), async (route) => {
    if (!refuse) return route.continue();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "the database went away" }),
    });
  });

  await page.goto(`/projects/${PROJECT_KEY}/settings`);
  const alert = page.getByRole("alert").filter({ hasText: "could not be loaded" });
  await expect(alert).toContainText("the database went away");

  refuse = false;
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "could not be loaded" })).toHaveCount(0);
  await expect(page.getByPlaceholder("Search settings")).toBeVisible();
});

test.describe("an agent with unsaved changes", () => {
  let agentId: string;

  test.beforeEach(async () => {
    const handle = await db();
    // The block catalog is seeded at server start and seed() empties the database
    // Push too: a pipeline that writes files is refused a save without one, which is the product's
    // rule and not what this test is about
    await handle.collection("agentblocks").insertMany(
      [
        { key: "implement", name: "Implement", description: "Make the change", capability: "edit" },
        { key: "push", name: "Push", description: "Send it", capability: "read-only", deterministic: true },
      ].map((b) => ({
        kind: "step",
        builtIn: true,
        gateKind: "",
        params: {},
        prompt: "",
        createdAt: new Date(),
        updatedAt: new Date(),
        ...b,
      }))
    );
    const inserted = await handle.collection("agents").insertOne({
      name: "Left unsaved",
      description: "",
      scope: "global",
      owner: null,
      project: null,
      builtIn: false,
      composition: { analysis: [], implementation: [], verification: [], delivery: [] },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    agentId = String(inserted.insertedId);
  });

  test("asks before leaving, and says so on the page before anybody tries", async ({ page }) => {
    await signIn(page, "admin");
    const listed = page.waitForResponse((r) => r.url().includes("/api/agents") && r.ok());
    await page.goto(`/agents/${agentId}`);
    await listed;
    await expect(page.getByRole("heading", { name: "Left unsaved" })).toBeVisible();

    // The control: an agent nobody has touched is not reported as changed
    await expect(page.getByText("Unsaved changes")).toHaveCount(0);

    await page.getByRole("button", { name: "Add Implement to a phase" }).click();
    await page.getByLabel("Where to add Implement").getByRole("button", { name: "Implementation" }).click();
    await expect(page.getByText("Unsaved changes")).toBeVisible();

    await test.step("declining keeps the page and the placed step", async () => {
      let asked = "";
      page.once("dialog", (dialog) => {
        asked = dialog.message();
        void dialog.dismiss();
      });
      await page.getByRole("link", { name: "Back" }).click();
      await expect.poll(() => asked).toContain("not saved");
      await page.waitForTimeout(500);
      expect(new URL(page.url()).pathname).toBe(`/agents/${agentId}`);
      await expect(page.getByTestId("bucket-implementation")).toContainText("Implement");
    });

    await test.step("once saved, leaving asks nothing", async () => {
      await page.getByRole("button", { name: "Add Push to a phase" }).click();
      await page.getByLabel("Where to add Push").getByRole("button", { name: "Delivery" }).click();
      const saved = write(page, "PUT", `/api/agents/${agentId}`);
      await page.getByRole("button", { name: "Save" }).click();
      expect((await saved).status()).toBe(200);
      await expect(page.getByText("Unsaved changes")).toHaveCount(0);

      let askedAgain = false;
      page.once("dialog", (dialog) => {
        askedAgain = true;
        void dialog.dismiss();
      });
      await page.getByRole("link", { name: "Back" }).click();
      await expect(page).toHaveURL(/\/agents$/);
      expect(askedAgain).toBe(false);
    });
  });
});

test("the new-task form calls acceptance criteria by the name the task shows them under", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByRole("button", { name: "New task" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Acceptance criteria", { exact: true })).toBeVisible();
  await expect(dialog.getByPlaceholder("Add criterion")).toBeVisible();
  await expect(dialog.getByText("Checklist", { exact: true })).toHaveCount(0);
});
