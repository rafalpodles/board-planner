import { test, expect, type Page } from "@playwright/test";
import {
  PROJECT_KEY,
  PROJECT_NAME,
  SECOND_PROJECT_KEY,
  SECOND_PROJECT_NAME,
  seed,
  seedSecondProject,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-918: with the sidebar collapsed to its icon rail there was no way to change project, or to
 * go from a board to its sprints, without opening the sidebar first. The rail now lists the
 * projects and, under the one you are in, its sections; and the sidebar can also rest narrow and
 * open over the page while the pointer is on it.
 *
 * The component tests say what the rail renders. What only a browser can say is whether the links
 * take you there, and whether the hover state is an overlay — the page must not move under the
 * pointer when the sidebar opens, and it must not stay open once the pointer has gone.
 */

const DESKTOP = { width: 1280, height: 800 };
const RAIL_WIDTH = 56;
const OPEN_WIDTH = 260;

test.beforeEach(async () => {
  await seed();
  await seedSecondProject();
});

async function openAs(page: Page, mode: "collapsed" | "hover" | "expanded", path: string) {
  await page.setViewportSize(DESKTOP);
  await signIn(page);
  await page.addInitScript((value) => localStorage.setItem("sidebar-mode", value), mode);
  await page.goto(path);
}

const sidebar = (page: Page) => page.locator("aside");
const width = async (page: Page) => Math.round((await sidebar(page).boundingBox())!.width);

test.describe("the collapsed rail", () => {
  test("goes from a board to its sprints and back, and to another project", async ({ page }) => {
    await openAs(page, "collapsed", `/projects/${PROJECT_KEY}`);
    await expect.poll(() => width(page)).toBe(RAIL_WIDTH);

    const sections = sidebar(page).getByRole("group", { name: `${PROJECT_NAME} sections` });
    await expect(sections.getByRole("link", { name: "Board", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await sections.getByRole("link", { name: "Sprints" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/sprints$`));
    await expect(sections.getByRole("link", { name: "Sprints" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(sections.getByRole("link", { name: "Board", exact: true })).not.toHaveAttribute(
      "aria-current",
      "page",
    );

    await sections.getByRole("link", { name: "Board", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));

    await sidebar(page).getByRole("link", { name: SECOND_PROJECT_NAME }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${SECOND_PROJECT_KEY}$`));
    // The other project's sections replace the first's; a rail with both open would be a tree
    await expect(
      sidebar(page).getByRole("group", { name: `${SECOND_PROJECT_NAME} sections` }),
    ).toBeVisible();
    await expect(
      sidebar(page).getByRole("group", { name: `${PROJECT_NAME} sections` }),
    ).toHaveCount(0);
  });

  test("stays narrow while it is used", async ({ page }) => {
    await openAs(page, "collapsed", `/projects/${PROJECT_KEY}`);
    await sidebar(page).getByRole("link", { name: "Sprints" }).hover();
    await page.waitForTimeout(400);
    expect(await width(page)).toBe(RAIL_WIDTH);
  });
});

test.describe("expand on hover", () => {
  test("rests as the rail, opens over the page without moving it, and closes again", async ({
    page,
  }) => {
    await openAs(page, "hover", `/projects/${PROJECT_KEY}`);
    await expect.poll(() => width(page)).toBe(RAIL_WIDTH);
    const main = page.locator("#main-content");
    const before = (await main.boundingBox())!.x;

    await sidebar(page).getByRole("link", { name: "Sprints" }).hover();
    await expect.poll(() => width(page)).toBe(OPEN_WIDTH);
    await expect(sidebar(page).getByText("My Tasks")).toBeVisible();
    // An overlay: the page keeps its place under it instead of being pushed along
    expect((await main.boundingBox())!.x).toBe(before);

    await page.mouse.move(DESKTOP.width - 40, DESKTOP.height / 2);
    await expect.poll(() => width(page)).toBe(RAIL_WIDTH);
    await expect(sidebar(page).getByText("My Tasks")).toHaveCount(0);
  });

  test("a click on the rail does not leave it open once the pointer has gone", async ({ page }) => {
    await openAs(page, "hover", `/projects/${PROJECT_KEY}`);
    await sidebar(page).getByRole("link", { name: "Sprints" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/sprints$`));
    await page.mouse.move(DESKTOP.width - 40, DESKTOP.height / 2);
    await expect.poll(() => width(page)).toBe(RAIL_WIDTH);
  });

  test("a keyboard user tabbing into the rail opens it", async ({ page }) => {
    await openAs(page, "hover", `/projects/${PROJECT_KEY}`);
    await expect.poll(() => width(page)).toBe(RAIL_WIDTH);
    await sidebar(page).getByRole("link", { name: "Sprints" }).focus();
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => width(page)).toBe(OPEN_WIDTH);
  });
});

test.describe("choosing the state", () => {
  test("the three states are in the account menu and the choice survives a reload", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}`);
    await expect.poll(() => width(page)).toBe(OPEN_WIDTH);

    const choose = async (name: string) => {
      await sidebar(page).getByRole("button", { name: "Account menu" }).click();
      await sidebar(page).getByRole("group", { name: "Sidebar" }).getByRole("button", { name }).click();
    };

    await choose("Collapsed");
    await expect.poll(() => width(page)).toBe(RAIL_WIDTH);
    await page.reload();
    await expect.poll(() => width(page)).toBe(RAIL_WIDTH);

    await choose("Expand on hover");
    await page.reload();
    await expect(sidebar(page).getByLabel("Pin sidebar open")).toHaveCount(0);
    await sidebar(page).getByRole("link", { name: "Sprints" }).hover();
    await expect(page.getByRole("button", { name: "Pin sidebar open" })).toBeVisible();

    await page.getByRole("button", { name: "Pin sidebar open" }).click();
    await page.mouse.move(DESKTOP.width - 40, DESKTOP.height / 2);
    await page.reload();
    await expect.poll(() => width(page)).toBe(OPEN_WIDTH);
  });
});
