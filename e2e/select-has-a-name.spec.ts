import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, SIBLING_TASK_NUMBER, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-450. `Select` rendered its `<label>` with no `htmlFor` and without wrapping the control, so
 * every select in the app had no accessible name at all — a screen reader announced "combo box"
 * and the value, and nothing about what it selects. Its sibling `Input` had always minted an id
 * with `useId()` and pointed the label at it, so this was an inconsistency inside the design
 * system rather than a decision.
 */

test.beforeEach(seed);

/**
 * Asked of the DOM the way an assistive technology resolves a name: an explicit `for`, an ancestor
 * `<label>`, or an `aria-label`. Returns the ones with none of them, plus how many were examined —
 * a page that renders no selects at all must not read as a page with no unnamed ones.
 */
async function selectNaming(page: Page) {
  return page.evaluate(() => {
    const visible = [...document.querySelectorAll("select")].filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    // Asked of each candidate whether it produces TEXT, not merely whether it exists. The first
    // version of this accepted a `label[for]` with nothing in it, an `aria-labelledby` pointing at
    // a missing id, and any ancestor `<label>` at all — three ways to pass while a reader still
    // hears "combo box" and a value (BP-498).
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
  // "How often" renders only while the schedule is on, and it is the field the ticket was found on
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

/**
 * The PM section's auth-type select renders only when a server row exists, and the seed sets
 * `mcpServers: []` — so the sweep visited this page and never saw it. Written here rather than in
 * the seed: every other spec keeps the board it expects.
 */
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
  // Named per row, so this is also the assertion that the row rendered at all — an admin sees the
  // server's name in an input, which is why `getByText("acme")` finds nothing here
  await expect(page.getByLabel("Authentication for acme")).toBeVisible();
}

async function customFieldForm(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=fields`);
  await page.getByRole("button", { name: "+ Add field" }).click();
  // Waits on the form's OTHER field on purpose. Waiting on the select this ticket names would make
  // its absence a "locator not found" in the helper, where the sweep below prints the offending
  // element instead — a worse message for the failure that matters.
  await expect(page.getByPlaceholder("Component")).toBeVisible();
}

async function workerSettings(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=workers`);
  await expect(page.getByRole("heading", { name: "Agent", exact: true })).toBeVisible();
}

async function integrationSettings(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=integrations`);
  // The channel form lives inside a collapsed card — the select does not exist until it is opened,
  // which is a second reason the old sweep could visit this page and see nothing
  // Filtered by text rather than by accessible name: the card's title and blurb sit in elements
  // that do not contribute one, so `getByRole("button", { name: /^Team channels/ })` matches
  // nothing at all — which is worth knowing, because it is the same gap this ticket is about.
  await page.getByRole("button").filter({ hasText: "Team channels" }).click();
  await expect(page.getByLabel("New channel type")).toBeVisible();
}

async function dependencyPicker(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
  await page.getByRole("button", { name: "+ Add dependency" }).click();
  // The search box, not the select — same reasoning as the custom field form above
  await expect(page.getByPlaceholder("Search tasks...")).toBeVisible();
}

const SURFACES: [string, (page: Page) => Promise<void>][] = [
  ["the PM autonomy form", pmSettings],
  ["the sprint form", sprintForm],
  ["the new-task form", newTaskForm],
  ["the agent composer", agentComposer],
  // BP-498. Five selects never went through `Select`, and none of them was on a surface this swept
  // — which is most of why they looked covered.
  ["the PM's MCP servers", pmServers],
  ["the custom field form", customFieldForm],
  ["the worker settings", workerSettings],
  ["the integration settings", integrationSettings],
  ["the dependency picker", dependencyPicker],
];

/**
 * Nine surfaces, not "every select the app renders" — the old title claimed the whole app while
 * covering four, and five unnamed selects sat outside them for a month. What this actually
 * guarantees is that these nine surfaces hold no unnamed select; `select-has-a-name` in the source
 * is the list to keep in step.
 */
test.describe("the selects on the surfaces this sweeps", () => {
  for (const [where, open] of SURFACES) {
    test(`has a name on ${where}`, async ({ page }) => {
      await signIn(page);
      await open(page);

      const { examined, unnamed } = await selectNaming(page);
      // A surface with no selects would satisfy the assertion below without meaning anything
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

  // Dirty puts a marker span inside the same <label>, carrying title="Unsaved". It must not
  // become part of what a screen reader reads out.
  await howOften.selectOption("12");
  await expect(page.locator('span[title="Unsaved"]').first()).toBeVisible();
  await expect(howOften).toHaveAccessibleName("How often");
});

/**
 * The control, and the half an attribute check cannot make: reaching the field the way a person
 * does has to actually drive it. BP-391's spec had to say
 * `getByText("How often").locator("xpath=following-sibling::select")` and left a comment pointing
 * at this ticket; that locator is replaced in the same commit.
 */
test("getByLabel reaches the select, and selecting through it works", async ({ page }) => {
  await signIn(page);
  await pmSettings(page);

  const howOften = page.getByLabel("How often");
  await howOften.selectOption("6");
  await expect(howOften).toHaveValue("6");

  /**
   * The preview is derived from the value, so this is where a select that reads but does not
   * drive would show. Every six hours from 09:00 gives 09, 15 and 21; the default of once a day
   * gives 09 alone, so 15:00 appears only because the select actually moved.
   */
  await expect(page.getByText(/3 reviews a day, at 09:00, 15:00, 21:00/)).toBeVisible();
});

/**
 * BP-498, the sixth marker. `DirtyDot` in the settings nav carries `title="Unsaved changes"` and
 * sits inside the section's own button, so an unsaved section announced as "Board Unsaved changes".
 * The five markers BP-450 dealt with were spelled `title="Unsaved"`, which is why a grep for that
 * string did not find this one.
 *
 * Nothing goes red without this today — the specs that reach these buttons match by substring —
 * but the button's name is what a screen reader reads and what the next exact-name locator will
 * depend on.
 */
test("a section with unsaved changes is still announced by its own name", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=board`);

  const navButton = page.getByRole("button", { name: "Board", exact: true });
  // The control: the name is exact before anything is dirty, so a failure below is the marker and
  // not a locator that never worked
  await expect(navButton).toHaveCount(1);

  await page.getByLabel("What Planned means to automation").selectOption("approved");
  // The premise: the section really is dirty now
  await expect(page.locator('span[title="Unsaved changes"]').first()).toBeVisible();

  await expect(navButton).toHaveCount(1);
  await expect(navButton).toHaveAccessibleName("Board");
});
