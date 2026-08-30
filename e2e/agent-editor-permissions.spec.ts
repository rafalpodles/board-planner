import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-459. The palette, the drag handles, the remove buttons and Save were rendered to everybody,
 * while `mayEdit` on the server wants an instance admin for a global agent. A member could open
 * the shipped Default, rearrange its gates, and learn on pressing Save that it was never theirs.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

let agentId: string;

test.beforeEach(async () => {
  await seed();
  const handle = await db();
  /**
   * The block catalog is seeded once at server start and `seed()` empties the database, so
   * without this `lookup` resolves nothing and every bucket renders empty — which is exactly how
   * the first version of this spec passed: its "control" matched the bucket heading
   * *Implementation*, not the block.
   */
  await handle.collection("agentblocks").insertMany([
    {
      key: "implement",
      kind: "step",
      name: "Implement",
      description: "",
      builtIn: true,
      gateKind: "",
      params: {},
      prompt: "",
      capability: "edit",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      key: "push",
      kind: "step",
      name: "Push",
      description: "",
      builtIn: true,
      gateKind: "",
      params: {},
      prompt: "",
      capability: "read-only",
      deterministic: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
  // A global agent that is not one of the shipped three, so nothing else in the suite depends on
  // the name and the Rename affordance is offered to somebody who may use it
  const inserted = await handle.collection("agents").insertOne({
    name: "A global one",
    description: "Composed by an instance admin",
    scope: "global",
    owner: null,
    project: null,
    builtIn: false,
    composition: {
      analysis: [],
      implementation: [{ key: "implement" }],
      verification: [],
      delivery: [{ key: "push" }],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  agentId = String(inserted.insertedId);
});

async function openAgent(page: Page) {
  const listed = page.waitForResponse((r) => r.url().includes("/api/agents") && r.ok());
  await page.goto(`/agents/${agentId}`);
  await listed;
  await expect(page.getByRole("heading", { name: "A global one" })).toBeVisible();
}

test("a member is shown the composition and none of the controls that edit it", async ({
  page,
}) => {
  await signIn(page, "member");
  await openAgent(page);

  // The control, and it has to be exact: `getByText("Implement")` also matches the bucket
  // heading *Implementation*, which is on screen whether or not the composition resolved — the
  // first version of this test passed against completely empty buckets that way.
  await expect(page.getByText("Implement", { exact: true })).toBeVisible();
  await expect(page.getByText("Push", { exact: true })).toBeVisible();

  await expect(page.getByTestId("agent-read-only")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Rename" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
});

test("an instance admin is offered all of them", async ({ page }) => {
  await signIn(page, "admin");
  await openAgent(page);

  await expect(page.getByTestId("agent-read-only")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rename" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Remove / }).first()).toBeVisible();
});

test("an admin can rename it, and the new name is what the catalog then shows", async ({
  page,
}) => {
  await signIn(page, "admin");
  await openAgent(page);

  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("Agent name").fill("Renamed by hand");
  const written = page.waitForResponse(
    (r) => r.request().method() === "PUT" && r.url().includes("/api/agents/") && r.ok(),
  );
  await page.getByRole("button", { name: "Save name" }).click();
  await written;

  await expect(page.getByRole("heading", { name: "Renamed by hand" })).toBeVisible();

  await page.goto("/agents");
  await expect(page.getByText("Renamed by hand")).toBeVisible();
});
