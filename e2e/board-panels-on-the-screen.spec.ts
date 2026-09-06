import { test, expect, type Page } from "@playwright/test";
import { PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

test.beforeEach(seed);

interface Box {
  left: number;
  right: number;
  width: number;
  viewport: number;
  transform: string;
}

async function boxOf(page: Page, name: string): Promise<Box> {
  return page.getByRole(name === "Filters" ? "dialog" : "group", { name }).evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      viewport: window.innerWidth,
      transform: getComputedStyle(el).transform,
    };
  });
}

async function openPanel(page: Page, button: string) {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByRole("button", { name: button })).toBeVisible();
  await page.getByRole("button", { name: button }).click();
}

function expectOnScreen(box: Box, what: string) {
  expect(box.left, `${what} starts ${Math.round(-box.left)}px past the left edge`).toBeGreaterThanOrEqual(0);
  expect(
    box.right,
    `${what} ends ${Math.round(box.right - box.viewport)}px past the right edge`
  ).toBeLessThanOrEqual(box.viewport);
  expect(box.width, `${what} has no width — was it opened at all?`).toBeGreaterThan(100);
}

for (const width of [360, 375, 390, 414, 430, 480, 600, 639, 640]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 }, hasTouch: true, isMobile: width < 768 });

    test("both of the board's panels open on the screen", async ({ page }) => {
      await signIn(page, "admin");

      await openPanel(page, "Filters");
      expectOnScreen(await boxOf(page, "Filters"), `the Filters panel at ${width}px`);
      await expect(page.getByRole("dialog", { name: "Filters" }).getByLabel("Assignee")).toBeVisible();

      await page.getByRole("button", { name: "List", exact: true }).click();
      await page.getByRole("button", { name: "Choose columns" }).click();
      expectOnScreen(await boxOf(page, "Columns"), `the Columns panel at ${width}px`);
    });
  });
}

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the panels open where they always did, at their full width", async ({ page }) => {
    await signIn(page, "admin");

    await openPanel(page, "Filters");
    const filters = await boxOf(page, "Filters");
    expectOnScreen(filters, "the Filters panel on a desktop");
    expect(Math.round(filters.width)).toBe(340);
    expect(filters.transform, "the clamp moved a panel that was already in place").toBe("none");

    await page.getByRole("button", { name: "List", exact: true }).click();
    await page.getByRole("button", { name: "Choose columns" }).click();
    const columns = await boxOf(page, "Columns");
    expectOnScreen(columns, "the Columns panel on a desktop");
    expect(Math.round(columns.width)).toBe(224);
    expect(columns.transform, "the clamp moved a panel that was already in place").toBe("none");
  });
});

test.describe("after a click inside the panel", () => {
  test.use({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true });

  test("the Filters panel is still on the screen", async ({ page }) => {
    await signIn(page, "admin");
    await openPanel(page, "Filters");
    const before = await boxOf(page, "Filters");
    expectOnScreen(before, "the Filters panel before the click");

    const dialog = page.getByRole("dialog", { name: "Filters" });
    await dialog.getByLabel("Priority").selectOption({ label: "High" });
    await expect(page.getByRole("button", { name: "Filters" })).toContainText("1");

    expectOnScreen(await boxOf(page, "Filters"), "the Filters panel after picking a priority");
  });
});
