import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, seed } from "./seed";
import { signIn } from "./session";

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

const BLOCKS = [
  { key: "implement", name: "Implement", description: "Make the change", capability: "edit" },
  { key: "push", name: "Push", description: "Send it somewhere", capability: "read-only", deterministic: true },
  { key: "review", name: "Review", description: "", capability: "read-only" },
];

let agentId: string;

test.beforeEach(async () => {
  await seed();
  const handle = await db();
  await handle.collection("agentblocks").insertMany(
    BLOCKS.map((b) => ({
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
    name: "Composed by hand",
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

async function openComposer(page: Page) {
  await signIn(page, "admin");
  const listed = page.waitForResponse((r) => r.url().includes("/api/agents") && r.ok());
  await page.goto(`/agents/${agentId}`);
  await listed;
  await expect(page.getByRole("heading", { name: "Composed by hand" })).toBeVisible();
}

const bucket = (page: Page, id: string) => page.getByTestId(`bucket-${id}`);

const grip = (page: Page, name: string) =>
  page.locator('[aria-roledescription="draggable"]').filter({ hasText: name }).first();

const announced = (page: Page) =>
  page.locator('[id^="DndLiveRegion"]').filter({ hasText: /./ }).last();

test("a block reaches a bucket with the keyboard alone, and lands where it said", async ({
  page,
}) => {
  await openComposer(page);

  for (const id of ["analysis", "implementation", "verification", "delivery"]) {
    await expect(bucket(page, id).locator("li"), id).toHaveCount(0);
  }

  await grip(page, "Implement").focus();
  await page.keyboard.press("Space");
  await expect(announced(page)).toContainText("Picked up draggable item new:implement");

  await page.keyboard.press("ArrowLeft");
  await expect(announced(page)).toContainText(
    "was moved over droppable area bucket:analysis"
  );

  await page.keyboard.press("Space");
  await expect(announced(page)).toContainText("was dropped over droppable area bucket:analysis");

  await expect(bucket(page, "analysis")).toContainText("Implement");
});

test("the Add control puts a block in the phase it names, without any drag", async ({ page }) => {
  await openComposer(page);

  await page.getByRole("button", { name: "Add Implement to a phase" }).click();
  await page.getByLabel("Where to add Implement").getByRole("button", { name: "Delivery" }).click();

  await expect(bucket(page, "delivery")).toContainText("Implement");
  await expect(bucket(page, "analysis")).not.toContainText("Implement");
  await expect(bucket(page, "implementation")).not.toContainText("Implement");
});

test("an agent can be composed end to end and saved, using no pointer at all", async ({ page }) => {
  await openComposer(page);

  await page.getByRole("button", { name: "Add Implement to a phase" }).press("Enter");
  await page
    .getByLabel("Where to add Implement")
    .getByRole("button", { name: "Implementation" })
    .press("Enter");
  await page.getByRole("button", { name: "Add Push to a phase" }).press("Enter");
  await page.getByLabel("Where to add Push").getByRole("button", { name: "Delivery" }).press("Enter");

  await expect(bucket(page, "implementation")).toContainText("Implement");
  await expect(bucket(page, "delivery")).toContainText("Push");

  const saved = page.waitForResponse(
    (r) => r.request().method() === "PUT" && r.url().includes("/api/agents/") && r.ok()
  );
  await page.getByRole("button", { name: "Save" }).press("Enter");
  await saved;

  const handle = await db();
  const stored = await handle
    .collection("agents")
    .findOne({ _id: new mongoose.Types.ObjectId(agentId) });
  expect(stored?.composition.implementation.map((e: { key: string }) => e.key)).toEqual([
    "implement",
  ]);
  expect(stored?.composition.delivery.map((e: { key: string }) => e.key)).toEqual(["push"]);
});

test("an entry already in a bucket can be moved to another one from the keyboard", async ({
  page,
}) => {
  await openComposer(page);

  await page.getByRole("button", { name: "Add Implement to a phase" }).click();
  await page.getByLabel("Where to add Implement").getByRole("button", { name: "Analysis" }).click();
  await expect(bucket(page, "analysis").locator("li")).toHaveCount(1);

  const entry = bucket(page, "analysis")
    .locator('[aria-roledescription="sortable"]')
    .filter({ hasText: "Implement" })
    .first();
  await entry.focus();
  await page.keyboard.press("Space");
  await expect(announced(page)).toContainText("was moved over droppable area");

  let over = await announced(page).textContent();
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => announced(page).textContent()).not.toBe(over);
  await page.keyboard.press("Space");

  await expect(bucket(page, "analysis").locator("li")).toHaveCount(0);
  await expect(bucket(page, "implementation")).toContainText("Implement");
});

test("reordering inside a bucket still works from the keyboard", async ({ page }) => {
  await openComposer(page);

  for (const name of ["Implement", "Review", "Push"]) {
    await page.getByRole("button", { name: `Add ${name} to a phase` }).click();
    await page.getByLabel(`Where to add ${name}`).getByRole("button", { name: "Analysis" }).click();
  }

  const order = async () =>
    (await bucket(page, "analysis").locator("li .font-medium").allTextContents()).map((t) =>
      t.trim()
    );
  expect(await order()).toEqual(["Implement", "Review", "Push"]);

  const inBucket = bucket(page, "analysis")
    .locator('[aria-roledescription="sortable"]')
    .filter({ hasText: "Implement" })
    .first();

  await inBucket.focus();
  await page.keyboard.press("Space");
  await expect(announced(page)).toContainText("was moved over droppable area");
  await expect(announced(page), "the palette block was picked up instead").not.toContainText(
    "new:implement"
  );

  let over = await announced(page).textContent();
  for (let step = 0; step < 2; step += 1) {
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => announced(page).textContent()).not.toBe(over);
    over = await announced(page).textContent();
  }
  await page.keyboard.press("Space");

  await expect.poll(order).toEqual(["Review", "Push", "Implement"]);
});
