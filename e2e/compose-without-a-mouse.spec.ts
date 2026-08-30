import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-455. The composition editor registers a `KeyboardSensor`, so every palette block advertises
 * itself as draggable and dnd-kit announces the pick-up out loud. Then every arrow key did nothing
 * at all: `sortableKeyboardCoordinates` computes the next position from the items of a
 * `SortableContext`, and a palette block is a plain `useDraggable` belonging to none — so the
 * getter had nothing to compute from and the drag stayed pinned where it started.
 *
 * Composing an agent is the whole point of that screen, and it was the one thing on it that could
 * not be done without a mouse. Worse than missing: the interface said the operation had begun and
 * then silently refused to continue.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

/**
 * The descriptions are load-bearing, and unevenly so. `BlockBody` renders one as a `<p>`, and an
 * empty one collapses to no line box — so a block with a description is a taller row than one
 * without. `sortableKeyboardCoordinates` and the fallback search differ only by an offset term of
 * `{ collisionRect.height - newRect.height }`, which is zero while every row is identical; with
 * all three descriptions blank, deleting the delegation left the whole spec green.
 */
const BLOCKS = [
  { key: "implement", name: "Implement", description: "Make the change", capability: "edit" },
  { key: "push", name: "Push", description: "Send it somewhere", capability: "read-only", deterministic: true },
  { key: "review", name: "Review", description: "", capability: "read-only" },
];

let agentId: string;

test.beforeEach(async () => {
  await seed();
  const handle = await db();
  // The block catalog is seeded at server start and seed() empties the database, so without this
  // `lookup` resolves nothing and every bucket renders empty whatever the drag did
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

/** The palette block's own grip — dnd-kit gives it role="button" and tabIndex 0 */
const grip = (page: Page, name: string) =>
  page.locator('[aria-roledescription="draggable"]').filter({ hasText: name }).first();

/**
 * dnd-kit's own live region, which is where this bug was measured in the first place: the pick-up
 * was announced and then no arrow key ever produced a second line.
 *
 * Asserting on it is also the synchronisation. A drag is processed on the next tick, so pressing
 * Space and ArrowLeft back to back leaves the second key arriving before the sensor has started —
 * which is exactly how the first version of this spec failed while the feature worked.
 */
const announced = (page: Page) =>
  // Two DndContexts render on this page, so two live regions exist and only one is ever speaking.
  // An empty filter is not circular: with nothing announced this resolves to no element at all,
  // and the assertion still fails.
  page.locator('[id^="DndLiveRegion"]').filter({ hasText: /./ }).last();

test("a block reaches a bucket with the keyboard alone, and lands where it said", async ({
  page,
}) => {
  await openComposer(page);

  // The control: every bucket starts empty, so the assertion below cannot be true of the page as
  // it loads. Counted rather than negated — `not.toContainText` also passes on a bucket that has
  // not rendered, which is the opposite of what this is meant to establish.
  for (const id of ["analysis", "implementation", "verification", "delivery"]) {
    await expect(bucket(page, id).locator("li"), id).toHaveCount(0);
  }

  await grip(page, "Implement").focus();
  await page.keyboard.press("Space");
  await expect(announced(page)).toContainText("Picked up draggable item new:implement");

  // The palette is the right-hand column, so the buckets are to the left. This line is the whole
  // ticket: before the fix, no arrow key ever produced it.
  await page.keyboard.press("ArrowLeft");
  await expect(announced(page)).toContainText(
    "was moved over droppable area bucket:analysis"
  );

  await page.keyboard.press("Space");
  await expect(announced(page)).toContainText("was dropped over droppable area bucket:analysis");

  // It landed where the announcement said it would
  await expect(bucket(page, "analysis")).toContainText("Implement");
});

test("the Add control puts a block in the phase it names, without any drag", async ({ page }) => {
  await openComposer(page);

  await page.getByRole("button", { name: "Add Implement to a phase" }).click();
  await page.getByLabel("Where to add Implement").getByRole("button", { name: "Delivery" }).click();

  await expect(bucket(page, "delivery")).toContainText("Implement");
  // Named the phase, so it must not have landed in another one
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

  // What reached the server, not what the screen says: the editor is optimistic
  const handle = await db();
  const stored = await handle
    .collection("agents")
    .findOne({ _id: new mongoose.Types.ObjectId(agentId) });
  expect(stored?.composition.implementation.map((e: { key: string }) => e.key)).toEqual([
    "implement",
  ]);
  expect(stored?.composition.delivery.map((e: { key: string }) => e.key)).toEqual(["push"]);
});

/**
 * A sortable active crossing *containers*, which is the gesture the delegation is most likely to
 * matter for — the entry leaves one SortableContext for another.
 */
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

/**
 * The half that already worked, asserted so the new coordinate getter cannot have taken it away:
 * a sortable active still goes through `sortableKeyboardCoordinates` exactly as before.
 *
 * Three entries, and the first travels to the end. Two was not enough to tell the delegation from
 * the cross-container fallback — with one neighbour both pick the same rectangle, and removing the
 * delegation left every assertion green.
 */
test("reordering inside a bucket still works from the keyboard", async ({ page }) => {
  await openComposer(page);

  for (const name of ["Implement", "Review", "Push"]) {
    await page.getByRole("button", { name: `Add ${name} to a phase` }).click();
    await page.getByLabel(`Where to add ${name}`).getByRole("button", { name: "Analysis" }).click();
  }

  // The name span, not the row: `allTextContents` on the row returns name and description run
  // together, and the `.split("\n")` that used to stand here never had a newline to find
  const order = async () =>
    (await bucket(page, "analysis").locator("li .font-medium").allTextContents()).map((t) =>
      t.trim()
    );
  expect(await order()).toEqual(["Implement", "Review", "Push"]);

  /**
   * The one inside the bucket, not the palette block of the same name — a bare `hasText` match
   * picks up `new:implement` and reorders nothing, which is how this read as a regression when it
   * was a locator.
   */
  const inBucket = bucket(page, "analysis")
    // "sortable", not "draggable": useSortable names its own role description, which is the tell
    // that this entry is in a SortableContext and the palette block is not
    .locator('[aria-roledescription="sortable"]')
    .filter({ hasText: "Implement" })
    .first();

  await inBucket.focus();
  await page.keyboard.press("Space");
  /**
   * A sortable entry is already over its own droppable, so dnd-kit replaces the pick-up line with
   * a move line on the same tick — which is the transcript the ticket recorded. Waiting for
   * "Picked up" here times out against working code.
   */
  await expect(announced(page)).toContainText("was moved over droppable area");
  await expect(announced(page), "the palette block was picked up instead").not.toContainText(
    "new:implement"
  );

  // The drop target has to actually change before the drop, and the announcement is the only
  // signal that it has — pressing Space on the same tick drops it back where it started
  let over = await announced(page).textContent();
  for (let step = 0; step < 2; step += 1) {
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => announced(page).textContent()).not.toBe(over);
    over = await announced(page).textContent();
  }
  await page.keyboard.press("Space");

  await expect.poll(order).toEqual(["Review", "Push", "Implement"]);
});
