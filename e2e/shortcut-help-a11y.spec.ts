import { test, expect, type Page } from "@playwright/test";
import { PROJECT_KEY, STRANDED_SPRINT_ID, seed, seedTaskInCompletedSprint } from "./seed";
import { signIn } from "./session";

const helpDialog = (page: Page) => page.getByRole("dialog", { name: "Keyboard Shortcuts" });

const cardVisible = (page: Page) =>
  expect(page.locator(`a[href^="/projects/${PROJECT_KEY}/tasks/"]`).first()).toBeVisible();

async function openBoard(page: Page) {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await cardVisible(page);
}

async function openHelp(page: Page) {
  await page.keyboard.press("?");
  await expect(helpDialog(page)).toBeVisible();
}

test.describe("on a normal board", () => {
  test.beforeEach(seed);

  test("the shortcuts are grouped as a definition list, pairing each description with its key", async ({
    page,
  }) => {
    await openBoard(page);
    await openHelp(page);

    await expect(helpDialog(page).locator("dl").first()).toBeVisible();

    const searchRow = helpDialog(page).locator("dl > div", { hasText: "Search tasks and projects" });
    await expect(searchRow.locator("dt")).toHaveText("Search tasks and projects");
    await expect(searchRow.locator("dd kbd")).toBeVisible();
  });

  test("a glyph key also carries a spoken label for screen readers", async ({ page }) => {
    await openBoard(page);
    await openHelp(page);

    const searchRow = helpDialog(page).locator("dl > div", { hasText: "Search tasks and projects" });
    await expect(searchRow.getByText("Cmd", { exact: true })).toBeAttached();
    await expect(searchRow.locator("kbd")).toContainText("K / /");
  });

  test('only search is listed as available anywhere; board-only shortcuts are not', async ({
    page,
  }) => {
    await openBoard(page);
    await openHelp(page);

    const anywhere = helpDialog(page).locator("section", {
      has: page.getByRole("heading", { name: "Anywhere" }),
    });
    await expect(anywhere.getByText("Search tasks and projects")).toBeVisible();
    await expect(anywhere.getByText("Create new task")).toHaveCount(0);
    await expect(anywhere.getByText("Refresh board")).toHaveCount(0);

    await expect(helpDialog(page).getByText("Create new task")).toBeVisible();
  });

  test("N and V are offered on a normal, unlocked board", async ({ page }) => {
    await openBoard(page);
    await openHelp(page);

    await expect(helpDialog(page).getByText("Create new task")).toBeVisible();
    await expect(helpDialog(page).getByText("Toggle view: board")).toBeVisible();
  });
});

test.describe("on a read-only, view-locked board", () => {
  test.beforeEach(async () => {
    await seed();
    await seedTaskInCompletedSprint();
  });

  test("hides the shortcuts that would do nothing", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/sprints?sprint=${STRANDED_SPRINT_ID}`);
    await expect(page.getByTestId("sprint-name")).toBeVisible();

    await openHelp(page);

    await expect(helpDialog(page).getByText("Create new task")).toHaveCount(0);
    await expect(helpDialog(page).getByText("Toggle view: board")).toHaveCount(0);

    await expect(helpDialog(page).getByText("Refresh board")).toBeVisible();
    await expect(helpDialog(page).getByText("Search tasks and projects")).toBeVisible();
  });
});
