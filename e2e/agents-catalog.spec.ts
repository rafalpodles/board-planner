import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH, MEMBER_AUTH } from "./api";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  FINISHED_TASK_NUMBER,
  MEMBER_ID,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  SIBLING_TASK_ID,
  SIBLING_TASK_KEY,
  SIBLING_TASK_NUMBER,
  seed,
  taskFactory,
} from "./seed";
import { signIn } from "./session";

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

async function seedCatalog() {
  await mongoose.connect(E2E_MONGODB_URI);
  const { seedAgents } = await import("@/lib/agent-seed");
  await seedAgents();
  await mongoose.disconnect();
}

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

async function makeRunnable(name: string) {
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

const selectBelow = (page: Page, label: string): Locator =>
  page.getByText(label, { exact: true }).locator("xpath=following-sibling::select");

async function openCatalog(page: Page) {
  await page.goto(AGENTS_URL);
  await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(DEFAULT_AGENT) })).toBeVisible();
}

function countAgentWrites(page: Page): () => number {
  let seen = 0;
  page.on("request", (r) => {
    if (r.method() === "PUT" && new URL(r.url()).pathname.startsWith("/api/agents/")) seen += 1;
  });
  return () => seen;
}

const bucketOf = (page: Page, label: string): Locator =>
  page.getByRole("heading", { name: label, exact: true }).locator("xpath=../following-sibling::ul");

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

    await expect(page.getByLabel("Name")).toHaveValue("Not mine to give");
    await selectBelow(page, "Who can use it").selectOption({ label: "Only me" });
    await page.getByRole("button", { name: "Create" }).click();
    await expect(section(page, "Mine").getByText("Not mine to give")).toBeVisible();
    expect(await storedAgent("Not mine to give")).toMatchObject({ scope: "user" });
  });
});

test.describe("editing what an agent does", () => {
  const bucket = bucketOf;

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

    await dragOnto(page, palette.getByRole("button", { name: /^Push/ }), bucket(page, "Delivery"));
    await expect(bucket(page, "Delivery").getByText("Push", { exact: true })).toBeVisible();

    expect(writes(), "the editor wrote before Save was pressed").toBe(0);
    expect((await storedAgent("Hand-built"))?.composition).toMatchObject({ implementation: [] });

    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();

    await expect
      .poll(async () => (await storedAgent("Hand-built"))?.composition)
      .toMatchObject({ implementation: [{ key: "implement" }], delivery: [{ key: "push" }] });

    await page.reload();
    await expect(bucket(page, "Implementation").getByText("Implement", { exact: true })).toBeVisible();
  });

  test("the order inside a bucket can be changed from the keyboard, and it is kept", async ({
    page,
  }) => {
    await signIn(page);
    const id = await agentIdByName(DEFAULT_AGENT);
    await page.goto(`/agents/${id}`);
    await expect(page.getByRole("heading", { name: DEFAULT_AGENT, level: 1 })).toBeVisible();

    await expect(rowsIn(page, "Verification")).toHaveText([
      /^Protected files/,
      /^Size/,
      /^Test written/,
      /^Builds/,
      /^Tests pass/,
      /^Reviewed/,
    ]);

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
    await expect(complaint).toHaveCount(0);

    await page.getByRole("button", { name: "Remove Pull request" }).click();

    await expect(complaint).toBeVisible();
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

    const id = await agentIdByName("Spoken for");
    await withDb(async (db) => {
      await db
        .collection("tasks")
        .updateOne({ _id: SIBLING_TASK_ID }, { $set: { agent: new mongoose.Types.ObjectId(id) } });
    });

    await page.reload();
    await page.getByRole("button", { name: "Delete Spoken for" }).click();

    await expect(
      page.getByText(`Still in use by task ${SIBLING_TASK_KEY}. Point those elsewhere first.`)
    ).toBeVisible();
    expect(await storedAgent("Spoken for")).not.toBeNull();
  });

  test("and goes through once nothing points at it", async ({ page }) => {
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

test.describe("what the refusal names", () => {
  async function tasksNaming(agentId: string, count: number): Promise<string[]> {
    const numbers = Array.from({ length: count }, (_, i) => 900 + i);
    const scrambled = [...numbers].reverse();
    await withDb(async (db) => {
      const build = taskFactory(new Date());
      await db.collection("tasks").insertMany(
        scrambled.map((taskNumber, i) =>
          build({
            taskNumber,
            title: `Points at the agent ${taskNumber}`,
            status: "todo",
            agent: new mongoose.Types.ObjectId(agentId),
            order: i,
          })
        )
      );
      await db
        .collection("projects")
        .updateOne({ _id: PROJECT_ID }, { $max: { taskCounter: numbers[numbers.length - 1] } });
    });
    return numbers.map((n) => `${PROJECT_KEY}-${n}`);
  }

  async function refusalFor(request: APIRequestContext, agentId: string): Promise<string> {
    const response = await request.delete(`/api/agents/${agentId}`, { headers: ADMIN_AUTH });
    expect(response.status()).toBe(409);
    return ((await response.json()) as { error: string }).error;
  }

  async function newAgent(page: Page, name: string): Promise<string> {
    await openCatalog(page);
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill(name);
    await page.getByRole("button", { name: "Create" }).click();
    return agentIdByName(name);
  }

  test("every task, when there are few enough to name", async ({ page, request }) => {
    await signIn(page);
    const id = await newAgent(page, "Named by three");
    const keys = await tasksNaming(id, 3);

    expect(await refusalFor(request, id)).toBe(
      `Still in use by tasks ${keys.join(", ")}. Point those elsewhere first.`
    );
  });

  test("all ten at the cap, with nothing trailing", async ({ page, request }) => {
    await signIn(page);
    const id = await newAgent(page, "Named by ten");
    const keys = await tasksNaming(id, 10);

    const error = await refusalFor(request, id);
    expect(error).toBe(`Still in use by tasks ${keys.join(", ")}. Point those elsewhere first.`);
    expect(error).not.toContain("more");
  });

  test("ten and a count, one past the cap", async ({ page, request }) => {
    await signIn(page);
    const id = await newAgent(page, "Named by eleven");
    const keys = await tasksNaming(id, 11);

    expect(await refusalFor(request, id)).toBe(
      `Still in use by tasks ${keys.slice(0, 10).join(", ")} and 1 more. Point those elsewhere first.`
    );
  });

  test("the count past the cap is the number left, not the total", async ({ page, request }) => {
    await signIn(page);
    const id = await newAgent(page, "Named by eighteen");
    const keys = await tasksNaming(id, 18);

    expect(await refusalFor(request, id)).toBe(
      `Still in use by tasks ${keys.slice(0, 10).join(", ")} and 8 more. Point those elsewhere first.`
    );
  });

  test("counts, rather than names, a task on a board the caller cannot open", async ({ request }) => {
    const id = await withDb(async (db) => {
      const result = await db.collection("agents").insertOne({
        name: "A member's own",
        description: "",
        scope: "user",
        owner: MEMBER_ID,
        project: null,
        builtIn: false,
        composition: { analysis: [], implementation: [], verification: [], delivery: [] },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return String(result.insertedId);
    });
    await withDb(async (db) => {
      await db
        .collection("tasks")
        .updateMany(
          { project: PROJECT_ID, taskNumber: { $in: [SIBLING_TASK_NUMBER, FINISHED_TASK_NUMBER] } },
          { $set: { agent: new mongoose.Types.ObjectId(id) } }
        );
      const removed = await db.collection("grants").deleteMany({ subject: MEMBER_ID, object: PROJECT_ID });
      expect(removed.deletedCount, "the fixture removed no grant, so nothing was revoked").toBeGreaterThan(0);
    });

    const response = await request.delete(`/api/agents/${id}`, { headers: MEMBER_AUTH });
    expect(response.status()).toBe(409);
    const { error } = (await response.json()) as { error: string };

    expect(error, "the refusal named a task on a board this caller cannot see").not.toContain(
      SIBLING_TASK_KEY
    );
    expect(error).toBe("Still in use by 2 tasks on boards you cannot open. Point those elsewhere first.");
  });

  test("names it for a member who does hold the board", async ({ request }) => {
    const id = await withDb(async (db) => {
      const result = await db.collection("agents").insertOne({
        name: "A member's own, still granted",
        description: "",
        scope: "user",
        owner: MEMBER_ID,
        project: null,
        builtIn: false,
        composition: { analysis: [], implementation: [], verification: [], delivery: [] },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return String(result.insertedId);
    });
    await withDb(async (db) => {
      await db
        .collection("tasks")
        .updateOne({ _id: SIBLING_TASK_ID }, { $set: { agent: new mongoose.Types.ObjectId(id) } });
      const grant = await db.collection("grants").countDocuments({ subject: MEMBER_ID, object: PROJECT_ID });
      expect(grant, "the member has no grant, so this proves nothing").toBeGreaterThan(0);
    });

    const response = await request.delete(`/api/agents/${id}`, { headers: MEMBER_AUTH });
    expect(response.status()).toBe(409);
    const { error } = (await response.json()) as { error: string };

    expect(error).toBe(`Still in use by task ${SIBLING_TASK_KEY}. Point those elsewhere first.`);
  });

  test("does not name a board the caller cannot open either", async ({ request }) => {
    const id = await withDb(async (db) => {
      const result = await db.collection("agents").insertOne({
        name: "A member's own, made a default",
        description: "",
        scope: "user",
        owner: MEMBER_ID,
        project: null,
        builtIn: false,
        composition: { analysis: [], implementation: [], verification: [], delivery: [] },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return String(result.insertedId);
    });
    await withDb(async (db) => {
      await db
        .collection("projects")
        .updateOne({ _id: PROJECT_ID }, { $set: { "worker.agent": new mongoose.Types.ObjectId(id) } });
      const removed = await db.collection("grants").deleteMany({ subject: MEMBER_ID, object: PROJECT_ID });
      expect(removed.deletedCount, "the fixture removed no grant, so nothing was revoked").toBeGreaterThan(0);
    });

    const response = await request.delete(`/api/agents/${id}`, { headers: MEMBER_AUTH });
    expect(response.status()).toBe(409);
    const { error } = (await response.json()) as { error: string };

    expect(error, "the refusal named a board this caller cannot see").not.toContain(PROJECT_NAME);
    expect(error).toContain("Still in use by");
  });

  test("a board with no name is still nameable", async ({ page, request }) => {
    await signIn(page);
    const id = await newAgent(page, "The nameless board's default");
    await withDb(async (db) => {
      await db.collection("projects").updateOne(
        { _id: PROJECT_ID },
        { $set: { name: "  ", "worker.agent": new mongoose.Types.ObjectId(id) } }
      );
    });

    expect(await refusalFor(request, id)).toBe(
      "Still in use by a project with no name. Point those elsewhere first."
    );
  });
});

test.describe("an agent stored in the shape that predates entries", () => {
  async function legacyAgent(name: string, keys: string[]): Promise<string> {
    return withDb(async (db) => {
      const result = await db.collection("agents").insertOne({
        name,
        description: "",
        scope: "global",
        owner: null,
        project: null,
        builtIn: false,
        composition: { analysis: keys, implementation: [], verification: [], delivery: [] },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return String(result.insertedId);
    });
  }

  test("can be renamed, and keeps what it was composed of", async ({ request }) => {
    const id = await legacyAgent("Written long ago", ["implement", "push"]);

    const response = await request.put(`/api/agents/${id}`, {
      headers: ADMIN_AUTH,
      data: { name: "Written long ago, renamed" },
    });
    expect(response.status(), await response.text()).toBe(200);

    const stored = await withDb(async (db) =>
      db.collection("agents").findOne({ _id: new mongoose.Types.ObjectId(id) })
    );
    expect(stored?.name).toBe("Written long ago, renamed");
    expect(stored?.composition?.analysis, "the composition was lost in the round trip").toHaveLength(
      2
    );
  });

  test("survives a save that changes nothing", async ({ request }) => {
    const id = await legacyAgent("Untouched by anyone", ["implement"]);

    const response = await request.put(`/api/agents/${id}`, { headers: ADMIN_AUTH, data: {} });
    expect(response.status(), await response.text()).toBe(200);
  });

  test("and so does one stored the way they are written now", async ({ request, page }) => {
    await signIn(page);
    await openCatalog(page);
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByLabel("Name").fill("Written today");
    await page.getByRole("button", { name: "Create" }).click();
    const id = await agentIdByName("Written today");

    expect(
      (await request.put(`/api/agents/${id}`, { headers: ADMIN_AUTH, data: { name: "Renamed today" } }))
        .status()
    ).toBe(200);
    expect((await request.put(`/api/agents/${id}`, { headers: ADMIN_AUTH, data: {} })).status()).toBe(
      200
    );
  });

  test("keeps working for the task that names it", async ({ request }) => {
    const id = await legacyAgent("Named by a task", ["implement"]);
    await withDb(async (db) => {
      await db
        .collection("tasks")
        .updateOne({ _id: SIBLING_TASK_ID }, { $set: { agent: new mongoose.Types.ObjectId(id) } });
    });

    const response = await request.put(`/api/agents/${id}`, {
      headers: ADMIN_AUTH,
      data: { name: "Renamed while a task pointed at it" },
    });
    expect(response.status(), await response.text()).toBe(200);

    const listed = await request.get("/api/agents", { headers: ADMIN_AUTH });
    const agents = (await listed.json()) as { _id: string; name: string; composition: Record<string, { key: string }[]> }[];
    const mine = agents.find((a) => a._id === id);
    expect(mine?.name).toBe("Renamed while a task pointed at it");
    expect(
      mine?.composition?.analysis?.map((e) => e.key),
      "the task is left pointing at an agent with nothing in it"
    ).toEqual(["implement"]);
  });
});

test.describe("emptying one that is still in use", () => {
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

    await withDb(async (db) => {
      await db
        .collection("tasks")
        .updateOne({ _id: SIBLING_TASK_ID }, { $set: { agent: new mongoose.Types.ObjectId(id) } });
    });

    await page.reload();
    await page.getByRole("button", { name: "Remove Size" }).click();
    await saving(page, id, 409);

    await expect(
      page.getByText(`Not saved. Still in use by task ${SIBLING_TASK_KEY}. Point those elsewhere first.`)
    ).toBeVisible();
    expect((await storedAgent("Spoken for"))?.composition).toMatchObject({
      verification: [{ key: "diff-size" }],
    });
  });

  test("goes through when nothing points at it, because that is a draft again", async ({ page }) => {
    await signIn(page);
    const id = await agentHolding(page, "Nobody's", ["diff-size"]);

    await page.getByRole("button", { name: "Remove Size" }).click();
    await saving(page, id, 200);

    await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();
    expect((await storedAgent("Nobody's"))?.composition).toMatchObject({ verification: [] });
  });

  test("is refused for a project's default too, not only for a task", async ({ page }) => {
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

    expect((await storedAgent("Names a ghost"))?.composition).toMatchObject({
      verification: [{ key: "diff-size" }],
    });
  });

  test("an in-use agent can still be edited, as long as it stays runnable", async ({ page }) => {
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
    await expect(page.getByRole("option", { name: "Board-wide reviewer" })).toBeVisible();
    await page.getByRole("option", { name: "Board-wide reviewer" }).click();

    const chosen = await agentIdByName("Board-wide reviewer");
    await expect.poll(storedTaskAgent).toBe(chosen);

  });

  test("a personal agent is withheld on a task that is not yours, and offered once you take it on", async ({
    page,
  }) => {
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
      await db.collection("tasks").updateOne({ _id: SIBLING_TASK_ID }, { $set: { assignee: ADMIN_ID } });
    });

    await signIn(page);
    await openTask(page);

    await agentRow(page).click();
    await expect(page.getByRole("option", { name: DEFAULT_AGENT })).toBeVisible();
    await expect(page.getByRole("option", { name: "The member's own" })).toHaveCount(0);
  });
});

test.describe("an agent with nothing in it", () => {
  test("is refused on a task, and the refusal says what to do about it", async ({ page }) => {
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
    await signIn(page);
    await openCatalog(page);
    await page.getByRole("tab", { name: "Gates" }).click();
    await page.getByRole("button", { name: "New gate" }).click();
    await page.getByLabel("Name").fill("Nobody uses me");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("button", { name: "Nobody uses me", exact: true })).toBeVisible();

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
    await signIn(page);
    await openCatalog(page);
    await page.getByRole("tab", { name: "Gates" }).click();
    await page.getByRole("button", { name: "New gate" }).click();
    await page.getByLabel("Name").fill("House style");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("button", { name: "House style", exact: true })).toBeVisible();

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
