import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, SIBLING_TASK_NUMBER, seed } from "./seed";
import { signIn } from "./session";

test.beforeEach(seed);

async function selectNaming(page: Page) {
  return page.evaluate(() => {
    const visible = [...document.querySelectorAll("select")].filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const text = (el: Element | null) => (el?.textContent ?? "").trim();
    const named = (el: HTMLSelectElement) => {
      if ((el.getAttribute("aria-label") ?? "").trim()) return true;
      const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
      if (ids.length && ids.every((id) => document.getElementById(id)) &&
          ids.map((id) => text(document.getElementById(id))).join(" ").trim()) {
        return true;
      }
      if (el.id && text(document.querySelector(`label[for="${CSS.escape(el.id)}"]`))) return true;
      return Boolean(text(el.closest("label")));
    };
    const unnamed = visible.filter((el) => !named(el));
    return {
      examined: visible.length,
      unnamed: unnamed.map((el) => el.outerHTML.slice(0, 100)),
    };
  });
}

async function pmSettings(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=pm`);
  await expect(page.getByRole("heading", { name: "When it acts on its own" })).toBeVisible();
  await page
    .getByRole("switch", { name: "Review the board on a schedule" })
    .locator("xpath=ancestor::label[1]")
    .click();
  await expect(page.getByLabel("Timezone")).toBeVisible();
}

async function sprintForm(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}/sprints`);
  await page.getByRole("button", { name: "New Sprint" }).click();
  await expect(page.getByRole("heading", { name: "New Sprint" })).toBeVisible();
}

async function newTaskForm(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByRole("button", { name: "New task" }).click();
  await expect(page.getByRole("heading", { name: "New Task" })).toBeVisible();
  await expect(page.getByPlaceholder("Describe what you need")).toBeVisible();
}

async function agentComposer(page: Page) {
  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "Agents" }).first()).toBeVisible();
  await page.getByRole("button", { name: /New agent/ }).click();
  await expect(page.getByLabel("Who can use it")).toBeVisible();
}

async function withMcpServer() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error("no database handle");
  await db.collection("projects").updateOne(
    { _id: PROJECT_ID },
    { $set: { "pm.mcpServers": [{ name: "acme", url: "https://acme.example/mcp", authType: "none" }] } }
  );
}

async function pmServers(page: Page) {
  await withMcpServer();
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=pm`);
  await expect(page.getByLabel("Authentication for acme")).toBeVisible();
}

async function customFieldForm(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=fields`);
  await page.getByRole("button", { name: "+ Add field" }).click();
  await expect(page.getByPlaceholder("Component")).toBeVisible();
}

async function workerSettings(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=workers`);
  await expect(page.getByRole("heading", { name: "Agent", exact: true })).toBeVisible();
}

async function integrationSettings(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=integrations`);
  await page.getByRole("button", { name: /^Team channels/ }).click();
  await expect(page.getByLabel("New channel type")).toBeVisible();
}

async function dependencyPicker(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
  await page.getByRole("button", { name: "+ Add dependency" }).click();
  await expect(page.getByPlaceholder("Search tasks...")).toBeVisible();
}

const SURFACES: [string, (page: Page) => Promise<void>][] = [
  ["the PM autonomy form", pmSettings],
  ["the sprint form", sprintForm],
  ["the new-task form", newTaskForm],
  ["the agent composer", agentComposer],
  ["the PM's MCP servers", pmServers],
  ["the custom field form", customFieldForm],
  ["the worker settings", workerSettings],
  ["the integration settings", integrationSettings],
  ["the dependency picker", dependencyPicker],
];

test.describe("the selects on the surfaces this sweeps", () => {
  for (const [where, open] of SURFACES) {
    test(`has a name on ${where}`, async ({ page }) => {
      await signIn(page);
      await open(page);

      const { examined, unnamed } = await selectNaming(page);
      expect(examined, `no select found on ${where} — the fixture, not the page`).toBeGreaterThan(0);
      expect(unnamed, `${examined} selects examined on ${where}`).toEqual([]);
    });
  }
});

test("the name is the label, and the unsaved dot is not part of it", async ({ page }) => {
  await signIn(page);
  await pmSettings(page);

  const howOften = page.getByLabel("How often");
  await expect(howOften).toHaveAccessibleName("How often");

  await howOften.selectOption("12");
  await expect(page.locator('span[title="Unsaved"]').first()).toBeVisible();
  await expect(howOften).toHaveAccessibleName("How often");
});

test("getByLabel reaches the select, and selecting through it works", async ({ page }) => {
  await signIn(page);
  await pmSettings(page);

  const howOften = page.getByLabel("How often");
  await howOften.selectOption("6");
  await expect(howOften).toHaveValue("6");

  await expect(page.getByText(/3 reviews a day, at 09:00, 15:00, 21:00/)).toBeVisible();
});

test("a section with unsaved changes is still announced by its own name", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=board`);

  const navButton = page.getByRole("button", { name: "Board", exact: true });
  await expect(navButton).toHaveCount(1);

  await page.getByLabel("What Planned means to automation").selectOption("approved");
  await expect(page.locator('span[title="Unsaved changes"]').first()).toBeVisible();

  await expect(navButton).toHaveCount(1);
  await expect(navButton).toHaveAccessibleName("Board");
});
