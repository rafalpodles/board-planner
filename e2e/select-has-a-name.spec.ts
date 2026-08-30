import { test, expect, type Page } from "@playwright/test";
import { PROJECT_KEY, seed } from "./seed";
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
    const unnamed = visible.filter(
      (el) =>
        !(el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) &&
        !el.getAttribute("aria-label") &&
        !el.getAttribute("aria-labelledby") &&
        !el.closest("label")
    );
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
  await page.getByLabel("Run a board review on a schedule").locator("xpath=ancestor::label[1]").click();
  await expect(page.getByLabel("Timezone")).toBeVisible();
}

async function taskFieldSettings(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=task-fields`);
  await expect(page.getByRole("heading", { name: "Task fields" })).toBeVisible();
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

const SURFACES: [string, (page: Page) => Promise<void>][] = [
  ["the PM autonomy form", pmSettings],
  ["the task-field settings", taskFieldSettings],
  ["the new-task form", newTaskForm],
  ["the agent composer", agentComposer],
];

test.describe("every select the app renders", () => {
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
  await expect(page.getByText(/4 reviews a day/)).toBeVisible();
});
