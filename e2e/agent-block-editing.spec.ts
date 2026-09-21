import { test, expect, type Locator, type Page, type Response } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH } from "./api";
import { E2E_MONGODB_URI, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-708. agents-catalog.spec.ts authors blocks and deletes them, and never once edits one:
 * `PUT /api/agent-blocks/[blockId]` received no request anywhere in the suite, and half the fields
 * of the three authoring dialogs were named by no test at all.
 *
 * Every write here is read back from Mongo rather than from the catalog, because the catalog
 * repaints from a reload the store runs itself — a screen that says the new name proves the reload
 * happened, not that the write did.
 */

const AGENT_NAME = "Careful with migrations";

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

async function seedCatalog() {
  await mongoose.connect(E2E_MONGODB_URI);
  const { seedAgents } = await import("@/lib/agent-seed");
  await seedAgents();
  await mongoose.disconnect();
}

const storedBlock = (query: Record<string, unknown>) =>
  withDb((db) => db.collection("agentblocks").findOne(query));

const storedAgent = (name: string) => withDb((db) => db.collection("agents").findOne({ name }));

test.beforeEach(async () => {
  await seed();
  await seedCatalog();
});

async function openCatalog(page: Page, tab?: "Gates" | "Steps") {
  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Default/ })).toBeVisible();
  if (tab) await page.getByRole("tab", { name: tab }).click();
}

const blockWrite = (page: Page, method: "POST" | "PUT" | "DELETE"): Promise<Response> =>
  page.waitForResponse(
    (r) => r.request().method() === method && new URL(r.url()).pathname.startsWith("/api/agent-blocks")
  );

/** A catalog row, found by the button that carries its name. */
const blockRow = (page: Page, name: string): Locator =>
  page.getByRole("button", { name, exact: true }).locator("xpath=ancestor::li[1]");

const bucketOf = (page: Page, label: string): Locator =>
  page.getByRole("heading", { name: label, exact: true }).locator("xpath=../following-sibling::ul");

/**
 * A block authored by the route the dialog calls, and an agent built from it beside an untouched
 * built-in — the control that shows the agent page is reading the composition at all.
 */
async function blockInAnAgent(
  page: Page,
  block: Record<string, unknown>,
  bucket: "implementation" | "verification"
) {
  const created = await page.request.post("/api/agent-blocks", { headers: ADMIN_AUTH, data: block });
  expect(created.status(), await created.text()).toBe(201);
  const { key } = (await created.json()) as { key: string };

  const composition = {
    analysis: [],
    implementation: bucket === "implementation" ? [{ key }, { key: "implement" }] : [{ key: "implement" }],
    verification: bucket === "verification" ? [{ key }, { key: "build" }] : [{ key: "build" }],
    delivery: [{ key: "push" }],
  };
  await withDb((db) =>
    db.collection("agents").insertOne({
      name: AGENT_NAME,
      description: "",
      scope: "global",
      owner: null,
      project: null,
      builtIn: false,
      composition,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  );
  return { key, composition };
}

test.describe("authoring, one field at a time", () => {
  test("a step keeps everything its form was given, including what it may touch", async ({ page }) => {
    await signIn(page);
    await openCatalog(page, "Steps");
    await page.getByRole("button", { name: "New step" }).click();

    const dialog = page.getByRole("dialog", { name: "New step" });
    await dialog.getByPlaceholder("Write the tests").fill("Write the tests first");
    await dialog.getByPlaceholder("One line, so it reads in a list").fill("Tests before code");
    await dialog.getByLabel("What it should do").fill("Write a failing test for the task.");
    // Neither default: a form that dropped either select would still store the first option
    await dialog.getByLabel("Model", { exact: true }).selectOption({ label: "Sonnet" });
    await dialog.getByLabel("What it may touch").selectOption({ label: "Read and write" });
    await expect(dialog.getByText("Can change files. The worker commits afterwards.")).toBeVisible();

    const posted = blockWrite(page, "POST");
    await dialog.getByRole("button", { name: "Create" }).click();
    expect((await posted).status()).toBe(201);

    expect(await storedBlock({ name: "Write the tests first" })).toMatchObject({
      kind: "step",
      description: "Tests before code",
      prompt: "Write a failing test for the task.",
      capability: "edit",
      model: "sonnet",
      builtIn: false,
    });
    await expect(blockRow(page, "Write the tests first")).toContainText("read and write · sonnet");
  });

  test("a gate keeps what it checks, and the parameters that kind asks for", async ({ page }) => {
    await signIn(page);
    await openCatalog(page, "Gates");
    await page.getByRole("button", { name: "New gate" }).click();

    const dialog = page.getByRole("dialog", { name: "New gate" });
    // Size is first and so the default; Reviewed is the kind whose parameters are selects
    await dialog.getByLabel("What it checks").selectOption({ label: "Reviewed" });
    await expect(dialog.getByText("A second model reads the change with no memory of writing it.")).toBeVisible();
    await dialog.getByLabel("Name").fill("Security pass");
    await dialog.getByLabel("Looking for").selectOption({ label: "Security" });
    await dialog.getByLabel("Model", { exact: true }).selectOption({ label: "Sonnet" });

    const posted = blockWrite(page, "POST");
    await dialog.getByRole("button", { name: "Create" }).click();
    expect((await posted).status()).toBe(201);

    expect(await storedBlock({ name: "Security pass" })).toMatchObject({
      kind: "gate",
      gateKind: "review",
      params: { focus: "security", model: "sonnet" },
    });
    await expect(blockRow(page, "Security pass")).toContainText("looking for Security · model Sonnet");
  });

  test("an agent's description is written when it is made, and can be rewritten later", async ({
    page,
  }) => {
    await signIn(page);
    await openCatalog(page);
    await page.getByRole("button", { name: "New agent" }).click();

    const dialog = page.getByRole("dialog", { name: "New agent" });
    await dialog.getByLabel("Name").fill(AGENT_NAME);
    await dialog.getByPlaceholder("When you would reach for this one").fill("For schema changes");
    const created = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/agents"
    );
    await dialog.getByRole("button", { name: "Create" }).click();
    expect((await created).status()).toBe(201);
    expect(await storedAgent(AGENT_NAME)).toMatchObject({ description: "For schema changes" });

    await page.getByRole("link", { name: new RegExp(AGENT_NAME) }).click();
    await expect(page.getByRole("heading", { name: AGENT_NAME, level: 1 })).toBeVisible();
    await expect(page.getByText("For schema changes", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Rename" }).click();
    await expect(page.getByLabel("Agent description")).toHaveValue("For schema changes");
    await page.getByLabel("Agent description").fill("For migrations that rewrite a table");
    const renamed = page.waitForResponse(
      (r) => r.request().method() === "PUT" && new URL(r.url()).pathname.startsWith("/api/agents/")
    );
    await page.getByRole("button", { name: "Save name" }).click();
    expect((await renamed).status()).toBe(200);

    expect(await storedAgent(AGENT_NAME)).toMatchObject({
      description: "For migrations that rewrite a table",
    });
    await page.reload();
    await expect(page.getByText("For migrations that rewrite a table", { exact: true })).toBeVisible();
    await expect(page.getByText("For schema changes", { exact: true })).toHaveCount(0);
  });
});

test.describe("editing a block an agent is built from", () => {
  test("a step's name, description and prompt change, and the agent shows it without losing a slot", async ({
    page,
  }) => {
    await signIn(page);
    const { key, composition } = await blockInAnAgent(
      page,
      {
        kind: "step",
        name: "Plan the change",
        description: "Reads before writing",
        prompt: "Read the code the task touches.",
        capability: "read-only",
        model: "opus",
      },
      "implementation"
    );

    await openCatalog(page, "Steps");
    await page.getByRole("button", { name: "Plan the change", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Plan the change" });
    // The fields fill from the row in an effect; typing before it lands is typing into nothing
    await expect(dialog.getByLabel("Name")).toHaveValue("Plan the change");
    await expect(dialog.getByLabel("What it should do")).toHaveValue("Read the code the task touches.");

    await dialog.getByLabel("Name").fill("Map the change");
    await dialog.getByLabel("Description").fill("Lists every file it will touch");
    await dialog.getByLabel("What it should do").fill("List the files the task will change, and why.");

    const saved = blockWrite(page, "PUT");
    await dialog.getByRole("button", { name: "Save" }).click();
    const response = await saved;
    expect(response.status(), await response.text()).toBe(200);
    await expect(dialog).toBeHidden();

    const block = await storedBlock({ key });
    expect(block).toMatchObject({
      key,
      name: "Map the change",
      description: "Lists every file it will touch",
      prompt: "List the files the task will change, and why.",
      // Not on the edit form, so not the edit's to change
      capability: "read-only",
      model: "opus",
    });
    expect(await storedBlock({ name: "Plan the change" })).toBeNull();

    // An edit is not a delete: the agent still names the block by its key, in its place
    expect((await storedAgent(AGENT_NAME))?.composition).toEqual(composition);

    await page.getByRole("tab", { name: "Agents" }).click();
    await page.getByRole("link", { name: new RegExp(AGENT_NAME) }).click();
    await expect(page.getByRole("heading", { name: AGENT_NAME, level: 1 })).toBeVisible();
    const implementation = bucketOf(page, "Implementation");
    await expect(implementation.getByText("Map the change", { exact: true })).toBeVisible();
    await expect(implementation.getByText("Lists every file it will touch")).toBeVisible();
    await expect(implementation.getByText("Plan the change", { exact: true })).toHaveCount(0);
    // The control beside it, in the same bucket: the neighbour nobody edited is still there
    await expect(implementation.getByText("Implement", { exact: true })).toBeVisible();
    await expect(implementation.locator("li [aria-roledescription]")).toHaveCount(2);
  });

  test("a gate's parameters change, and the agent keeps it where it was", async ({ page }) => {
    await signIn(page);
    const { key, composition } = await blockInAnAgent(
      page,
      { kind: "gate", name: "Small changes", gateKind: "diff-size", params: { maxLines: "400", maxFiles: "10" } },
      "verification"
    );

    await openCatalog(page, "Gates");
    await expect(blockRow(page, "Small changes")).toContainText("most lines 400 · most files 10");
    await page.getByRole("button", { name: "Small changes", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Small changes" });
    await expect(dialog.getByLabel("Most lines")).toHaveValue("400");
    // A gate has no prompt, and the form does not pretend it does
    await expect(dialog.getByLabel("What it should do")).toHaveCount(0);

    await dialog.getByLabel("Most lines").fill("150");
    await dialog.getByLabel("Most files").fill("4");
    await dialog.getByLabel("Description").fill("Keeps a change reviewable");

    const saved = blockWrite(page, "PUT");
    await dialog.getByRole("button", { name: "Save" }).click();
    expect((await saved).status()).toBe(200);

    expect(await storedBlock({ key })).toMatchObject({
      name: "Small changes",
      description: "Keeps a change reviewable",
      gateKind: "diff-size",
      params: { maxLines: "150", maxFiles: "4" },
    });
    expect((await storedAgent(AGENT_NAME))?.composition).toEqual(composition);
    await expect(blockRow(page, "Small changes")).toContainText("most lines 150 · most files 4");

    await page.getByRole("tab", { name: "Agents" }).click();
    await page.getByRole("link", { name: new RegExp(AGENT_NAME) }).click();
    const verification = bucketOf(page, "Verification");
    await expect(verification.getByText("Keeps a change reviewable")).toBeVisible();
    await expect(verification.getByText("Builds", { exact: true })).toBeVisible();
    await expect(verification.locator("li [aria-roledescription]")).toHaveCount(2);
  });

  test("a step the worker performs itself offers no prompt, and keeps having none", async ({ page }) => {
    await signIn(page);
    await openCatalog(page, "Steps");
    await page.getByRole("button", { name: "Push", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Push (default)" });
    await expect(dialog.getByLabel("Name")).toHaveValue("Push");
    await expect(dialog.getByText("This one is an action the worker takes.", { exact: false })).toBeVisible();
    await expect(dialog.getByLabel("What it should do")).toHaveCount(0);

    await dialog.getByLabel("Description").fill("Pushes the branch to origin.");
    const saved = blockWrite(page, "PUT");
    await dialog.getByRole("button", { name: "Save" }).click();
    expect((await saved).status()).toBe(200);

    expect(await storedBlock({ key: "push" })).toMatchObject({
      name: "Push",
      description: "Pushes the branch to origin.",
      deterministic: true,
      prompt: "",
    });
  });

  test("editing one in use goes through where deleting it is refused, and Cancel writes nothing", async ({
    page,
  }) => {
    await signIn(page);
    const { key, composition } = await blockInAnAgent(
      page,
      { kind: "gate", name: "House style", gateKind: "test-presence" },
      "verification"
    );

    await openCatalog(page, "Gates");

    let writes = 0;
    page.on("request", (r) => {
      if (r.method() === "PUT" && new URL(r.url()).pathname.startsWith("/api/agent-blocks/")) writes += 1;
    });
    await page.getByRole("button", { name: "House style", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "House style" });
    await expect(dialog.getByLabel("Name")).toHaveValue("House style");
    await dialog.getByLabel("Name").fill("Nobody saves this");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await page.waitForTimeout(1_000);
    expect(writes, "Cancel sent the edit anyway").toBe(0);
    expect(await storedBlock({ key })).toMatchObject({ name: "House style" });

    await page.getByRole("button", { name: "House style", exact: true }).click();
    await expect(dialog.getByLabel("Name")).toHaveValue("House style");
    await dialog.getByLabel("Name").fill("House rules");
    const saved = blockWrite(page, "PUT");
    await dialog.getByRole("button", { name: "Save" }).click();
    expect((await saved).status()).toBe(200);
    expect(await storedBlock({ key })).toMatchObject({ name: "House rules" });

    const deleted = blockWrite(page, "DELETE");
    await page.getByRole("button", { name: "Delete House rules" }).click();
    expect((await deleted).status()).toBe(409);
    await expect(
      page.getByText(`Still used by ${AGENT_NAME}. Take it out of those agents first.`)
    ).toBeVisible();
    expect(await storedBlock({ key })).toMatchObject({ name: "House rules" });
    expect((await storedAgent(AGENT_NAME))?.composition).toEqual(composition);
  });
});
