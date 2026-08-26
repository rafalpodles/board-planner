import { test, expect, type Locator, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH } from "./api";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  MEMBER_ID,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  seed,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-393. The agent catalog is where somebody decides what a machine will do to their branch, and
 * until now the only test that touched it was `assignee-access`, which cared about a picker
 * *withholding* an agent rather than about the catalog at all.
 *
 * The built-in agents and blocks are laid down by `seedAgents()` on boot (`src/instrumentation.ts`)
 * and `seed()` empties the whole database afterwards, so every test here re-runs the production
 * seeder rather than hand-writing a fixture — a hand-written one would describe the catalog this
 * spec wishes for instead of the one that ships.
 */

const AGENTS_URL = "/agents";

const DEFAULT_AGENT = "Default";
const MERGING_AGENT = "Merges its own work";
const SECURITY_AGENT = "With security review";

async function withDb<T>(fn: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  const dbName = new URL(E2E_MONGODB_URI.replace(/^mongodb/, "http")).pathname.slice(1);
  if (!dbName.endsWith("_e2e")) {
    throw new Error(`Refusing to touch database "${dbName}": this fixture only runs against *_e2e`);
  }
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    const handle = mongoose.connection.db;
    if (!handle) throw new Error("no database handle");
    return await fn(handle);
  } finally {
    await mongoose.disconnect();
  }
}

/** The catalog the product ships, laid down by the code that lays it down in production. */
async function seedCatalog() {
  await mongoose.connect(E2E_MONGODB_URI);
  const { seedAgents } = await import("@/lib/agent-seed");
  await seedAgents();
  await mongoose.disconnect();
}

/**
 * Polled, because clicking Create returns before the POST does. A straight read races it and the
 * test fails saying the agent does not exist, which reads like the product having lost it.
 */
async function agentIdByName(name: string): Promise<string> {
  let id: string | null = null;
  await expect
    .poll(async () => {
      id = await withDb(async (db) => {
        const agent = await db.collection("agents").findOne({ name });
        return agent ? String(agent._id) : null;
      });
      return id;
    })
    .not.toBeNull();
  return id!;
}

async function storedAgent(name: string): Promise<Record<string, unknown> | null> {
  return withDb(async (db) => db.collection("agents").findOne({ name }));
}

/**
 * The smallest composition a machine could actually run.
 *
 * Every agent is born empty and an empty one is a draft, which the task refuses to carry — "has no
 * steps in it yet, so a machine handed this task would have nothing to run". A test about *picking*
 * an agent should not be a test about composing one, so the composition arrives as a fixture.
 */
async function makeRunnable(name: string) {
  // Polled, not written once: clicking Create does not wait for the POST, so a straight updateOne
  // races it, matches nothing, and leaves the agent empty — which then reads as the server
  // refusing a perfectly good agent.
  await expect
    .poll(async () =>
      withDb(async (db) => {
        const result = await db.collection("agents").updateOne(
          { name },
          {
            $set: {
              composition: {
                analysis: [],
                implementation: [{ key: "implement" }],
                verification: [],
                delivery: [{ key: "push" }],
              },
            },
          }
        );
        return result.matchedCount;
      })
    )
    .toBe(1);
}

test.beforeEach(async () => {
  await seed();
  await seedCatalog();
});

const section = (page: Page, title: string): Locator =>
  page.getByRole("heading", { name: title, exact: true }).locator("xpath=..");

/** A `Select` has no accessible name in this app (BP-450), so it is reached by its label's sibling. */
const selectBelow = (page: Page, label: string): Locator =>
  page.getByText(label, { exact: true }).locator("xpath=following-sibling::select");

async function openCatalog(page: Page) {
  await page.goto(AGENTS_URL);
  await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
  // The lists arrive on their own request; the heading alone is a page that has not loaded
  await expect(page.getByRole("link", { name: new RegExp(DEFAULT_AGENT) })).toBeVisible();
}

/**
 * Counts the writes an agent could have received.
 *
 * "Nothing is written until Save" read straight from the database is an assertion taken inside the
 * round trip it describes: an eager write in flight beats it every time. Counting the requests is
 * what makes the claim falsifiable.
 */
function countAgentWrites(page: Page): () => number {
  let seen = 0;
  page.on("request", (r) => {
    if (r.method() === "PUT" && new URL(r.url()).pathname.startsWith("/api/agents/")) seen += 1;
  });
  return () => seen;
}

/** A bucket's list, addressed by its heading. */
const bucketOf = (page: Page, label: string): Locator =>
  page.getByRole("heading", { name: label, exact: true }).locator("xpath=../following-sibling::ul");

/**
 * A real pointer drag, because dnd-kit's PointerSensor is what a person uses and a `dispatchEvent`
 * shortcut against it is the classic way to write a drag test that stays green while the feature
 * is broken.
 *
 * The dwell at the end is not decoration, and it is worth being exact about why. dnd-kit publishes
 * `over` from its own move handling, so a `mouse.up` issued immediately after the last
 * `mouse.move` can reach `onDragEnd` with `over === null` — measured from dnd-kit's own live
 * region, which said "no longer over a droppable area" until the dwell was added. The re-measure
 * beside it is cheap insurance rather than the fix; nothing shifts layout *during* a drag, since
 * the overlay is fixed and the palette item only changes opacity.
 */
async function dragOnto(page: Page, item: Locator, target: Locator) {
  const from = (await item.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(
      from.x + ((to.x + to.width / 2 - from.x) * i) / 12,
      from.y + ((to.y + to.height / 2 - from.y) * i) / 12
    );
  }
  const settled = (await target.boundingBox())!;
  for (let i = 0; i < 4; i++) {
    await page.mouse.move(settled.x + settled.width / 2, settled.y + settled.height / 2 + i);
    await page.waitForTimeout(80);
  }
  await page.mouse.up();
  // Off the drop target and give the drag-end a frame. A click issued straight after `mouse.up()`
  // is swallowed — measured: the Save immediately after a drag sent no request at all, and the
  // same click one `boundingBox()` later sent it. `search.spec.ts` parks the pointer for its own
  // reasons; here it is what makes the next click land.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(150);
}

test.describe("the catalog as it ships", () => {
  test("shows what comes with Board Planner, and says the shelf is otherwise bare", async ({
    page,
  }) => {
    await signIn(page);
    await openCatalog(page);

    const global = section(page, "Global");
    for (const name of [DEFAULT_AGENT, MERGING_AGENT, SECURITY_AGENT]) {
      await expect(global.getByRole("link", { name: new RegExp(name) })).toBeVisible();
    }

    await expect(page.getByText("You have not created an agent yet.")).toBeVisible();
    await expect(page.getByText("No project has its own agent.")).toBeVisible();
  });

  test("what ships offers no delete, and what you made does", async ({ page }) => {
    await signIn(page);
    await openCatalog(page);

    // Named for what it proves. Two things withhold the control and either alone is enough: the
    // Global list is rendered with no `onDelete`, and the row also checks `builtIn`. Removing
    // either on its own leaves this green; removing both turns it red — measured, not assumed. The
    // server's own refusal of a built-in (400) has no path through this UI to reach.
    await expect(page.getByRole("button", { name: `Delete ${DEFAULT_AGENT}` })).toHaveCount(0);

    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Throwaway");
    await page.getByRole("button", { name: "Create" }).click();

    const remove = page.getByRole("button", { name: "Delete Throwaway" });
    await expect(remove).toBeVisible();
    await remove.click();
    await expect(page.getByText("You have not created an agent yet.")).toBeVisible();
    expect(await storedAgent("Throwaway")).toBeNull();
  });

  test("the three tabs are one panel at a time, and the arrow keys move between them", async ({
    page,
  }) => {
    await signIn(page);
    await openCatalog(page);

    const agentsPanel = page.locator("#catalog-agents");
    const gatesPanel = page.locator("#catalog-gates");
    await expect(agentsPanel).toBeVisible();
    await expect(gatesPanel).toBeHidden();

    // role="tablist" promises this to a screen reader, so it has to actually work
    await page.getByRole("tab", { name: "Agents" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Gates" })).toHaveAttribute("aria-selected", "true");
    await expect(gatesPanel).toBeVisible();
    await expect(agentsPanel).toBeHidden();

    await page.keyboard.press("End");
    await expect(page.getByRole("tab", { name: "Steps" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#catalog-steps")).toBeVisible();

    await page.keyboard.press("Home");
    await expect(page.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");
  });

  test("the action offered follows the tab, because authoring a step is not composing one", async ({
    page,
  }) => {
    // A member composes agents out of blocks that exist, and authors none: a step's prompt is what
    // runs on somebody's machine. The button is withheld where it would 403 rather than everywhere.
    await signIn(page, "member");
    await openCatalog(page);

    await expect(page.getByRole("button", { name: "New agent" })).toBeVisible();

    await page.getByRole("tab", { name: "Gates" }).click();
    await expect(page.getByRole("button", { name: "New gate" })).toHaveCount(0);
    await expect(page.getByText("An instance admin authors gates")).toBeVisible();

    await page.getByRole("tab", { name: "Steps" }).click();
    await expect(page.getByText("An instance admin authors steps")).toBeVisible();
  });
});

test.describe("composing one", () => {
  test("a new agent is mine, empty, and says so", async ({ page }) => {
    await signIn(page);
    await openCatalog(page);

    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Careful with migrations");
    await page.getByLabel("Description").fill("When the change touches a schema");
    await page.getByRole("button", { name: "Create" }).click();

    const mine = section(page, "Mine");
    await expect(mine.getByText("Careful with migrations")).toBeVisible();
    await expect(mine.getByText("When the change touches a schema")).toBeVisible();
    // Empty is a draft, not a fault
    await expect(mine.getByText("Nothing in it yet")).toBeVisible();

    const stored = await storedAgent("Careful with migrations");
    expect(stored).toMatchObject({ scope: "user", owner: ADMIN_ID, project: null });
  });

  test("an agent can belong to a project instead of to me", async ({ page }) => {
    await signIn(page);
    await openCatalog(page);

    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Board-wide");
    await selectBelow(page, "Who can use it").selectOption({ label: `Everyone on ${PROJECT_NAME}` });
    await page.getByRole("button", { name: "Create" }).click();

    const perProject = section(page, "Per project");
    await expect(perProject.getByText("Board-wide")).toBeVisible();
    await expect(perProject.getByText(PROJECT_NAME)).toBeVisible();

    const stored = await storedAgent("Board-wide");
    expect(stored).toMatchObject({ scope: "project", project: PROJECT_ID, owner: null });
  });

  test("a member cannot hand one to a project they only belong to, and is told so", async ({
    page,
  }) => {
    // The member holds a grant on TP but is not its admin. The dialog offers the project — the
    // refusal is the server's — so what matters is that the refusal reaches the person.
    await signIn(page, "member");
    await openCatalog(page);

    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Not mine to give");
    await selectBelow(page, "Who can use it").selectOption({ label: `Everyone on ${PROJECT_NAME}` });
    await page.getByRole("button", { name: "Create" }).click();

    await expect(
      page.getByText("Only a project admin can add an agent to a project")
    ).toBeVisible();
    expect(await storedAgent("Not mine to give")).toBeNull();

    // The control: the same person, the same dialog, kept for themselves. The dialog is still
    // open and still holds the typed name — a refusal leaves it standing rather than clearing it
    // (`Footer` only closes once onCreate resolves), which is what makes a second attempt possible
    // at all. Asserted, so a change there fails here rather than in a confusing missing-button.
    await expect(page.getByLabel("Name")).toHaveValue("Not mine to give");
    await selectBelow(page, "Who can use it").selectOption({ label: "Only me" });
    await page.getByRole("button", { name: "Create" }).click();
    await expect(section(page, "Mine").getByText("Not mine to give")).toBeVisible();
    expect(await storedAgent("Not mine to give")).toMatchObject({ scope: "user" });
  });
});

test.describe("editing what an agent does", () => {
  const bucket = bucketOf;

  /** The draggable rows of a bucket, top to bottom. Their text begins with the block's name. */
  const rowsIn = (page: Page, label: string) =>
    bucket(page, label).locator("li [aria-roledescription]");

  test("a block dragged from the palette lands in a bucket and survives a save", async ({ page }) => {
    await signIn(page);
    await openCatalog(page);

    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Hand-built");
    await page.getByRole("button", { name: "Create" }).click();
    await page.getByRole("link", { name: /Hand-built/ }).click();

    await expect(page.getByRole("heading", { name: "Hand-built", level: 1 })).toBeVisible();
    const writes = countAgentWrites(page);
    const target = bucket(page, "Implementation");
    await expect(target.getByText("Drag a step or a gate here.")).toBeVisible();

    const palette = page.locator("#main-content aside");
    await dragOnto(page, palette.getByRole("button", { name: /^Implement/ }), target);

    await expect(target.getByText("Implement", { exact: true })).toBeVisible();
    await expect(target.getByText("Drag a step or a gate here.")).toHaveCount(0);

    // A change nobody pushes stays in a worktree on the machine, and the rules refuse to store
    // that — so the agent is finished before it is saved rather than half-built.
    await dragOnto(page, palette.getByRole("button", { name: /^Push/ }), bucket(page, "Delivery"));
    await expect(bucket(page, "Delivery").getByText("Push", { exact: true })).toBeVisible();

    // Nothing is written until Save, which is what makes the Save below mean something
    expect(writes(), "the editor wrote before Save was pressed").toBe(0);
    expect((await storedAgent("Hand-built"))?.composition).toMatchObject({ implementation: [] });

    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();

    await expect
      .poll(async () => (await storedAgent("Hand-built"))?.composition)
      .toMatchObject({ implementation: [{ key: "implement" }], delivery: [{ key: "push" }] });

    // And still there on the way back in, rather than only in the page's own state
    await page.reload();
    await expect(bucket(page, "Implementation").getByText("Implement", { exact: true })).toBeVisible();
  });

  test("the order inside a bucket can be changed from the keyboard, and it is kept", async ({
    page,
  }) => {
    // Not a second copy of the drag above: dnd-kit's KeyboardSensor is a different sensor and a
    // different code path, and it is the only one a keyboard user has.
    await signIn(page);
    const id = await agentIdByName(DEFAULT_AGENT);
    await page.goto(`/agents/${id}`);
    await expect(page.getByRole("heading", { name: DEFAULT_AGENT, level: 1 })).toBeVisible();

    // Two gates in the middle of Verification, chosen because no rule constrains their order:
    // moving Protected files, Push or Pull request would make this a test about the rules, and the
    // save would be refused for a reason that has nothing to do with the keyboard.
    await expect(rowsIn(page, "Verification")).toHaveText([
      /^Protected files/,
      /^Size/,
      /^Test written/,
      /^Builds/,
      /^Tests pass/,
      /^Reviewed/,
    ]);

    // A beat between the keys: dnd-kit recomputes collisions on an animation frame, and three
    // presses in the same tick are picked up and dropped exactly where they started.
    await rowsIn(page, "Verification").nth(1).focus();
    await page.keyboard.press("Space");
    await page.waitForTimeout(250);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(250);
    await page.keyboard.press("Space");

    await expect(rowsIn(page, "Verification")).toHaveText([
      /^Protected files/,
      /^Test written/,
      /^Size/,
      /^Builds/,
      /^Tests pass/,
      /^Reviewed/,
    ]);

    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();

    await expect
      .poll(async () => (await storedAgent(DEFAULT_AGENT))?.composition)
      .toMatchObject({
        verification: [
          { key: "protected-paths" },
          { key: "test-presence" },
          { key: "diff-size" },
          { key: "build" },
          { key: "test-run" },
          { key: "review" },
        ],
      });
  });

  test("a block can be taken back out again", async ({ page }) => {
    await signIn(page);
    const id = await agentIdByName(DEFAULT_AGENT);
    await page.goto(`/agents/${id}`);
    await expect(page.getByRole("heading", { name: DEFAULT_AGENT, level: 1 })).toBeVisible();

    const writes = countAgentWrites(page);
    const implementation = bucket(page, "Implementation");
    await expect(implementation.getByText("Implement", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Remove Implement" }).click();
    await expect(implementation.getByText("Implement", { exact: true })).toHaveCount(0);

    // Taken out of the page, not out of the record: nothing is written until Save
    expect(writes(), "removing a block wrote to the server").toBe(0);
    expect((await storedAgent(DEFAULT_AGENT))?.composition).toMatchObject({
      implementation: [{ key: "implement" }],
    });
  });

  test("an agent that cannot work says why, before anything is saved", async ({ page }) => {
    await signIn(page);
    const id = await agentIdByName(MERGING_AGENT);
    await page.goto(`/agents/${id}`);
    await expect(page.getByRole("heading", { name: MERGING_AGENT, level: 1 })).toBeVisible();

    const writes = countAgentWrites(page);
    const complaint = page.getByText(
      "Merge runs without a pull request to merge. Put Pull request before it."
    );
    // Silent to begin with — the control, without which a banner that is always there would read
    // exactly like a banner that noticed something
    await expect(complaint).toHaveCount(0);

    await page.getByRole("button", { name: "Remove Pull request" }).click();

    await expect(complaint).toBeVisible();
    // Said before the save, not by it: the record is untouched, and nothing was even asked
    expect(writes(), "the rules banner came from the server rather than the page").toBe(0);
    expect((await storedAgent(MERGING_AGENT))?.composition).toMatchObject({
      delivery: [{ key: "push" }, { key: "pull-request" }, { key: "merge" }],
    });
  });
});

test.describe("deleting one that is still in use", () => {
  test("is refused, and the refusal names what is using it", async ({ page }) => {
    await signIn(page);
    await openCatalog(page);

    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Spoken for");
    await page.getByRole("button", { name: "Create" }).click();

    // A task now points at it — which is what a claim resolves, so deleting it would leave the
    // task claimed and handed straight back three times before it escalates
    const id = await agentIdByName("Spoken for");
    await withDb(async (db) => {
      await db
        .collection("tasks")
        .updateOne({ _id: SIBLING_TASK_ID }, { $set: { agent: new mongoose.Types.ObjectId(id) } });
    });

    await page.reload();
    await page.getByRole("button", { name: "Delete Spoken for" }).click();

    await expect(page.getByText(/Still in use by 1 task\. Point those elsewhere first\./)).toBeVisible();
    expect(await storedAgent("Spoken for")).not.toBeNull();
  });

  test("and goes through once nothing points at it", async ({ page }) => {
    // The control for the refusal above: same agent, same button, one reference apart
    await signIn(page);
    await openCatalog(page);

    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Spoken for");
    await page.getByRole("button", { name: "Create" }).click();

    await page.getByRole("button", { name: "Delete Spoken for" }).click();
    await expect(page.getByText(/Still in use/)).toHaveCount(0);
    await expect(page.getByText("You have not created an agent yet.")).toBeVisible();
    expect(await storedAgent("Spoken for")).toBeNull();
  });
});

test.describe("emptying one that is still in use", () => {
  /**
   * The composition is written rather than dragged in. What is under test is the save, and at the
   * 1280x720 the suite actually runs at (BP-449) the Gates half of the palette sits below the fold,
   * so a drag there fails for a reason that has nothing to do with this ticket. Composing by drag
   * is covered by its own tests above.
   *
   * Gates rather than steps: only `implement` carries capability "edit", and the push rule fires
   * for an agent that writes — so a gate-only composition is runnable and therefore saveable.
   */
  async function agentHolding(page: Page, name: string, keys: string[]) {
    await openCatalog(page);
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill(name);
    await page.getByRole("button", { name: "Create" }).click();

    const id = await agentIdByName(name);
    expect(
      await withDb(async (db) => {
        const result = await db
          .collection("agents")
          .updateOne(
            { _id: new mongoose.Types.ObjectId(id) },
            { $set: { "composition.verification": keys.map((key) => ({ key })) } }
          );
        return result.modifiedCount;
      }),
      "the fixture did not compose the agent"
    ).toBe(1);

    await page.goto(`/agents/${id}`);
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
    return id;
  }

  /**
   * The status is the assertion. "Saved" relabels itself back after two seconds and a refusal
   * renders somewhere else entirely, so reading the page cannot tell 409 from 200 reliably.
   */
  async function saving(page: Page, id: string, expected: number) {
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === "PUT" && r.url().includes(`/api/agents/${id}`)
      ),
      page.getByRole("button", { name: "Save" }).click(),
    ]);
    expect(response.status(), `the save answered ${response.status()}`).toBe(expected);
  }

  test("is refused with the sentence deleting it uses", async ({ page }) => {
    await signIn(page);
    const id = await agentHolding(page, "Spoken for", ["diff-size"]);

    // A task now points at it. Emptying it is the strictly equivalent act to deleting it, which the
    // describe above proves is refused — the two answers used to disagree (BP-457).
    await withDb(async (db) => {
      await db
        .collection("tasks")
        .updateOne({ _id: SIBLING_TASK_ID }, { $set: { agent: new mongoose.Types.ObjectId(id) } });
    });

    await page.reload();
    await page.getByRole("button", { name: "Remove Size" }).click();
    await saving(page, id, 409);

    await expect(
      page.getByText("Not saved. Still in use by 1 task. Point those elsewhere first.")
    ).toBeVisible();
    // What the guard is for: the task is still carrying something a claim can resolve
    expect((await storedAgent("Spoken for"))?.composition).toMatchObject({
      verification: [{ key: "diff-size" }],
    });
  });

  test("goes through when nothing points at it, because that is a draft again", async ({ page }) => {
    // The control. Without it a guard that refused every emptying would read exactly like this one.
    await signIn(page);
    const id = await agentHolding(page, "Nobody's", ["diff-size"]);

    await page.getByRole("button", { name: "Remove Size" }).click();
    await saving(page, id, 200);

    await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();
    expect((await storedAgent("Nobody's"))?.composition).toMatchObject({ verification: [] });
  });

  test("is refused for a project's default too, not only for a task", async ({ page }) => {
    // The reference lookup has two arms and the refusal above exercises only the task one. This
    // sets the project arm alone, so it fails if that arm is dropped and the other is not.
    await signIn(page);
    const id = await agentHolding(page, "The board's default", ["diff-size"]);
    await withDb(async (db) => {
      await db
        .collection("projects")
        .updateOne(
          { _id: PROJECT_ID },
          { $set: { "worker.agent": new mongoose.Types.ObjectId(id) } }
        );
    });

    await page.reload();
    await page.getByRole("button", { name: "Remove Size" }).click();
    await saving(page, id, 409);

    await expect(page.getByText(new RegExp(`Still in use by ${PROJECT_NAME}`))).toBeVisible();
    expect((await storedAgent("The board's default"))?.composition).toMatchObject({
      verification: [{ key: "diff-size" }],
    });
  });

  test("a composition naming a block that does not exist is refused too", async ({ page, request }) => {
    // `isRunnable` only counts entries, but `snapshotFor` also answers null when a key resolves to
    // no block (src/lib/agent-snapshot.ts:93) — so a non-empty composition of nonsense strands the
    // task exactly the way an empty one does. Driven over the API deliberately: the editor can only
    // offer blocks that exist, and refusalFor's own comment is that the editor is not the only way
    // in. Found by review of this branch, not by the ticket.
    await signIn(page);
    const id = await agentHolding(page, "Names a ghost", ["diff-size"]);
    await withDb(async (db) => {
      await db
        .collection("tasks")
        .updateOne({ _id: SIBLING_TASK_ID }, { $set: { agent: new mongoose.Types.ObjectId(id) } });
    });

    const response = await request.put(`/api/agents/${id}`, {
      headers: ADMIN_AUTH,
      data: { composition: { implementation: [{ key: "no-such-block" }] } },
    });
    expect(response.status(), await response.text()).toBe(400);

    // Unchanged, so the task still resolves a snapshot
    expect((await storedAgent("Names a ghost"))?.composition).toMatchObject({
      verification: [{ key: "diff-size" }],
    });
  });

  test("an in-use agent can still be edited, as long as it stays runnable", async ({ page }) => {
    // The guard is about references AND emptiness together. One that refused every edit to an
    // in-use agent would satisfy both refusals above and be a worse product.
    await signIn(page);
    const id = await agentHolding(page, "Busy but editable", ["diff-size", "protected-paths"]);
    await withDb(async (db) => {
      await db
        .collection("tasks")
        .updateOne({ _id: SIBLING_TASK_ID }, { $set: { agent: new mongoose.Types.ObjectId(id) } });
    });

    await page.reload();
    await page.getByRole("button", { name: "Remove Size" }).click();
    await saving(page, id, 200);

    expect((await storedAgent("Busy but editable"))?.composition).toMatchObject({
      verification: [{ key: "protected-paths" }],
    });
  });
});

test.describe("handing a task to one", () => {
  const TASK_URL = `/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;
  const agentRow = (page: Page) => page.getByRole("combobox", { name: "Agent" });

  async function openTask(page: Page) {
    await page.goto(TASK_URL);
    await expect(page.getByRole("textbox", { name: "Title" })).toBeVisible();
  }

  async function storedTaskAgent(): Promise<string | null> {
    return withDb(async (db) => {
      const task = await db.collection("tasks").findOne({ _id: SIBLING_TASK_ID });
      return task?.agent ? String(task.agent) : null;
    });
  }

  test("a project's agent is offered on its own tasks, and what is chosen is stored", async ({
    page,
  }) => {
    await signIn(page);
    await openCatalog(page);
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Board-wide reviewer");
    await selectBelow(page, "Who can use it").selectOption({ label: `Everyone on ${PROJECT_NAME}` });
    await page.getByRole("button", { name: "Create" }).click();
    await makeRunnable("Board-wide reviewer");

    await openTask(page);
    await agentRow(page).click();
    // Offered, and asserted as offered: without this the test's name is about the picker while its
    // body is only about the write, and the picker could stop listing it entirely
    await expect(page.getByRole("option", { name: "Board-wide reviewer" })).toBeVisible();
    await page.getByRole("option", { name: "Board-wide reviewer" }).click();

    // Choosing one is the hand-over gesture, so what matters is what the board ends up holding
    const chosen = await agentIdByName("Board-wide reviewer");
    await expect.poll(storedTaskAgent).toBe(chosen);

    // Not asserted here, and deliberately: an agent belonging to a *different* board is offered
    // too, and clicking it 400s with a retry that cannot work. That is BP-456, and its test
    // belongs with the fix rather than pinning the current behaviour as intended.
  });

  test("a personal agent is withheld on a task that is not yours, and offered once you take it on", async ({
    page,
  }) => {
    // The rule is keyed on the DRAFT assignee, so taking the task on and picking your own agent is
    // meant to work in one gesture. That is the whole of it, driven in one test.
    //
    // What this watches is the *picker's* filter, and only that: the server refuses the same thing
    // again in `agentUsableOnProject`, and removing that server rule leaves this green. The two are
    // not redundant — the server's arm has no path through this UI to reach, because a control that
    // 400s on click is exactly what the filter exists to avoid offering.
    await signIn(page);
    await openCatalog(page);
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Only mine");
    await page.getByRole("button", { name: "Create" }).click();
    await makeRunnable("Only mine");

    await openTask(page);
    await expect(
      page.getByText(/Your own agents are not offered here/)
    ).toBeVisible();
    await agentRow(page).click();
    await expect(page.getByRole("option", { name: "Only mine" })).toHaveCount(0);
    // The control: an agent that is not personal is on offer in the very same list
    await expect(page.getByRole("option", { name: DEFAULT_AGENT })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("combobox", { name: "Assignee" }).click();
    await page.getByRole("option", { name: /E2E Admin/ }).click();

    await agentRow(page).click();
    await expect(page.getByRole("option", { name: "Only mine" })).toBeVisible();
    await page.getByRole("option", { name: "Only mine" }).click();

    await expect.poll(storedTaskAgent).toBe(await agentIdByName("Only mine"));
  });

  test("somebody else's personal agent is never on offer, even on your own task", async ({
    page,
  }) => {
    await withDb(async (db) => {
      await db.collection("agents").insertOne({
        name: "The member's own",
        description: "",
        scope: "user",
        owner: MEMBER_ID,
        project: null,
        composition: { analysis: [], implementation: [], verification: [], delivery: [] },
        builtIn: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      // Assigned to the admin, so personal agents are offered at all — without this the absence
      // below would be the withholding rule rather than the ownership one
      await db.collection("tasks").updateOne({ _id: SIBLING_TASK_ID }, { $set: { assignee: ADMIN_ID } });
    });

    await signIn(page);
    await openTask(page);

    await agentRow(page).click();
    // The control FIRST. The options come from `/api/agents`, a different request from the task's
    // own, so an absence asserted before it lands is satisfied by an empty picker.
    await expect(page.getByRole("option", { name: DEFAULT_AGENT })).toBeVisible();
    await expect(page.getByRole("option", { name: "The member's own" })).toHaveCount(0);
  });
});

test.describe("an agent with nothing in it", () => {
  test("is refused on a task, and the refusal says what to do about it", async ({ page }) => {
    // Every agent is born empty, and an empty one is deliberately stored rather than refused — a
    // draft. What it must not do is reach a task, where a machine would claim it and hand it
    // straight back while every other claimable task on the project waits behind it.
    await signIn(page);
    await openCatalog(page);
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Still a draft");
    await selectBelow(page, "Who can use it").selectOption({ label: `Everyone on ${PROJECT_NAME}` });
    await page.getByRole("button", { name: "Create" }).click();

    await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
    await expect(page.getByRole("textbox", { name: "Title" })).toBeVisible();
    await page.getByRole("combobox", { name: "Agent" }).click();
    await page.getByRole("option", { name: "Still a draft" }).click();

    await expect(
      page.getByText(
        '"Still a draft" has no steps in it yet, so a machine handed this task would have nothing to run. Add at least one step to it first.'
      )
    ).toBeVisible();

    const stored = await withDb(async (db) =>
      db.collection("tasks").findOne({ _id: SIBLING_TASK_ID })
    );
    expect(stored?.agent ?? null).toBeNull();
  });

  test("and goes on once it has a step in it", async ({ page }) => {
    // The control: the same agent, the same click, one step apart
    await signIn(page);
    await openCatalog(page);
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Still a draft");
    await selectBelow(page, "Who can use it").selectOption({ label: `Everyone on ${PROJECT_NAME}` });
    await page.getByRole("button", { name: "Create" }).click();
    await makeRunnable("Still a draft");

    await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
    await expect(page.getByRole("textbox", { name: "Title" })).toBeVisible();
    await page.getByRole("combobox", { name: "Agent" }).click();
    await page.getByRole("option", { name: "Still a draft" }).click();

    await expect(page.getByText(/has no steps in it yet/)).toHaveCount(0);
    await expect
      .poll(async () => {
        const task = await withDb(async (db) =>
          db.collection("tasks").findOne({ _id: SIBLING_TASK_ID })
        );
        return task?.agent ? String(task.agent) : null;
      })
      .toBe(await agentIdByName("Still a draft"));
  });
});

test.describe("what else points at what", () => {
  test("the refusal counts a project's default as well as a task", async ({ page }) => {
    // The same `$or`-shaped guard has two arms, and the test above exercises only the task one.
    // A leak test covers the field it matched on and no other, so the project arm gets its own.
    await signIn(page);
    await openCatalog(page);
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("The board's default");
    await page.getByRole("button", { name: "Create" }).click();

    const id = await agentIdByName("The board's default");
    await withDb(async (db) => {
      await db
        .collection("projects")
        .updateOne({ _id: PROJECT_ID }, { $set: { "worker.agent": new mongoose.Types.ObjectId(id) } });
    });

    await page.reload();
    await page.getByRole("button", { name: "Delete The board's default" }).click();

    await expect(page.getByText(new RegExp(`Still in use by ${PROJECT_NAME}`))).toBeVisible();
    expect(await storedAgent("The board's default")).not.toBeNull();
  });

  test("a block nothing is built from is deleted, and is gone", async ({ page }) => {
    // The control for the refusal below, and the case BP-460 actually broke: every delete answered
    // 500, whether anything used the block or not.
    await signIn(page);
    await openCatalog(page);
    await page.getByRole("tab", { name: "Gates" }).click();
    await page.getByRole("button", { name: "New gate" }).click();
    await page.getByLabel("Name").fill("Nobody uses me");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("button", { name: "Nobody uses me", exact: true })).toBeVisible();

    // The status is what separates this from the bug: a 500 also removes nothing, so asserting
    // only that the row is gone would read the same against a server that had thrown.
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === "DELETE" && /\/api\/agent-blocks\//.test(r.url())
      ),
      page.getByRole("button", { name: "Delete Nobody uses me" }).click(),
    ]);
    expect(response.status(), "the delete answered something other than 200").toBe(200);

    await expect(page.getByRole("button", { name: "Nobody uses me", exact: true })).toHaveCount(0);
    await expect
      .poll(async () =>
        withDb(async (db) => db.collection("agentblocks").countDocuments({ name: "Nobody uses me" }))
      )
      .toBe(0);
  });

  test("a block an agent is built from cannot be deleted out from under it", async ({ page }) => {
    // It has to be a block somebody authored: the ones that ship carry `builtIn` and the list
    // offers them no delete control at all, so the server's 409 is unreachable through them.
    await signIn(page);
    await openCatalog(page);
    await page.getByRole("tab", { name: "Gates" }).click();
    await page.getByRole("button", { name: "New gate" }).click();
    await page.getByLabel("Name").fill("House style");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("button", { name: "House style", exact: true })).toBeVisible();

    // Put it inside an agent. Written rather than dragged, because what is under test is the
    // refusal, not the composing — which the drag tests above already cover. The write asserts it
    // matched, so a fixture that quietly hit nothing cannot read as the server letting a delete
    // through.
    let key = "";
    await expect
      .poll(async () => {
        key = await withDb(async (db) => {
          const block = await db.collection("agentblocks").findOne({ name: "House style" });
          return block ? String(block.key) : "";
        });
        return key;
      })
      .not.toBe("");

    expect(
      await withDb(async (db) => {
        const result = await db
          .collection("agents")
          .updateOne(
            { name: DEFAULT_AGENT },
            { $set: { "composition.verification": [{ key: "protected-paths" }, { key }] } }
          );
        return result.modifiedCount;
      }),
      "the fixture did not put the gate inside an agent"
    ).toBe(1);

    await page.reload();
    await page.getByRole("tab", { name: "Gates" }).click();
    await page.getByRole("button", { name: "Delete House style" }).click();

    await expect(
      page.getByText(`Still used by ${DEFAULT_AGENT}. Take it out of those agents first.`)
    ).toBeVisible();
    await expect
      .poll(async () =>
        withDb(async (db) => db.collection("agentblocks").countDocuments({ name: "House style" }))
      )
      .toBe(1);
  });

  test("the refusal finds a block named in the pre-object shape too", async ({ page }) => {
    // The arm above it is dotted and matches `{ key }` entries; this one is the other arm. Nothing
    // migrates the pre-object shape — normaliseComposition coerces it on read and only the
    // composition editor writes it back — so agents holding bare keys are live, and without this
    // the legacy arm could be deleted with every other test in the file still green.
    await signIn(page);
    await openCatalog(page);
    await page.getByRole("tab", { name: "Gates" }).click();
    await page.getByRole("button", { name: "New gate" }).click();
    await page.getByLabel("Name").fill("Old school");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("button", { name: "Old school", exact: true })).toBeVisible();

    let key = "";
    await expect
      .poll(async () => {
        key = await withDb(async (db) => {
          const block = await db.collection("agentblocks").findOne({ name: "Old school" });
          return block ? String(block.key) : "";
        });
        return key;
      })
      .not.toBe("");

    // Bare strings, written through the driver so nothing casts them into the modern shape on the
    // way in — which is exactly how these documents came to exist.
    expect(
      await withDb(async (db) => {
        const result = await db
          .collection("agents")
          .updateOne(
            { name: DEFAULT_AGENT },
            { $set: { "composition.verification": ["protected-paths", key] } }
          );
        return result.modifiedCount;
      }),
      "the fixture did not put the gate inside an agent"
    ).toBe(1);

    await page.reload();
    await page.getByRole("tab", { name: "Gates" }).click();
    await page.getByRole("button", { name: "Delete Old school" }).click();

    await expect(
      page.getByText(`Still used by ${DEFAULT_AGENT}. Take it out of those agents first.`)
    ).toBeVisible();
    await expect
      .poll(async () =>
        withDb(async (db) => db.collection("agentblocks").countDocuments({ name: "Old school" }))
      )
      .toBe(1);
  });

  test("a gate somebody authors turns up in the palette, ready to be composed with", async ({
    page,
  }) => {
    // The one link between the two tabs: a block authored on the catalog page is what the detail
    // page offers. Nothing anywhere asserted that the two ends meet.
    await signIn(page);
    await openCatalog(page);

    await page.getByRole("tab", { name: "Gates" }).click();
    await page.getByRole("button", { name: "New gate" }).click();
    await page.getByLabel("Name").fill("House style");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("button", { name: "House style", exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Agents" }).click();
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Uses the new gate");
    await page.getByRole("button", { name: "Create" }).click();
    await page.getByRole("link", { name: /Uses the new gate/ }).click();
    await expect(page.getByRole("heading", { name: "Uses the new gate", level: 1 })).toBeVisible();

    await expect(
      page.locator("#main-content aside").getByRole("button", { name: /^House style/ })
    ).toBeVisible();
  });

  test("a composition the server refuses says so on the page, and writes nothing", async ({
    page,
  }) => {
    // The client's own rules banner is covered above. This is the other one: the refusal that
    // comes back from the save, rendered as "Not saved. …", which no test had ever drawn.
    await signIn(page);
    await openCatalog(page);
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Writes and never sends");
    await page.getByRole("button", { name: "Create" }).click();
    await page.getByRole("link", { name: /Writes and never sends/ }).click();
    await expect(page.getByRole("heading", { name: "Writes and never sends", level: 1 })).toBeVisible();

    const palette = page.locator("#main-content aside");
    await dragOnto(page, palette.getByRole("button", { name: /^Implement/ }), bucketOf(page, "Implementation"));
    await expect(bucketOf(page, "Implementation").getByText("Implement", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Save" }).click();

    await expect(
      page.getByText(/Not saved\. Nothing pushes the work/)
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Saved" })).toHaveCount(0);
    expect((await storedAgent("Writes and never sends"))?.composition).toMatchObject({
      implementation: [],
    });
  });
});
