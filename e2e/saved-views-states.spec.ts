import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { AA_TEXT, DARK_SURFACE_MAX_LUMINANCE, surfaceLuminance, textContrast } from "./colour";
import { ADMIN_PASSWORD, ADMIN_USERNAME, HELD_TASK_ID, HELD_TASK_TITLE, PROJECT_KEY, SECOND_PROJECT_KEY, seed, seedSecondProject } from "./seed";
import { signIn, signInContext } from "./session";

/**
 * BP-886 follow-up: the Views menu with a keyboard, on a phone and in the dark theme, a `?view=`
 * link opened by somebody who is not signed in yet, a view that belongs to another board, and two
 * tabs saving the same name at once. Setup goes through the API; the assertions are on the screen.
 */
test.use({ colorScheme: "light" });
test.beforeEach(seed);

const BOARD = `/projects/${PROJECT_KEY}`;
const rows = (page: Page) => page.locator("table tbody tr:not([data-testid='list-group-header'])");
const menu = (page: Page) => page.getByRole("dialog", { name: "Views" });
const trigger = (page: Page) => page.getByRole("button", { name: "Views", exact: true });

async function createView(request: APIRequestContext, project: string, data: Record<string, unknown>) {
  const res = await request.post(`/api/projects/${project}/views`, { headers: ADMIN_AUTH, data });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { _id: string; name: string };
}

async function openBoard(page: Page) {
  await signIn(page);
  await page.goto(BOARD);
  await expect(trigger(page)).toBeVisible();
}

test("the Views menu opens from the keyboard, holds focus inside, and Escape gives it back to the button", async ({ page, request }) => {
  await createView(request, PROJECT_KEY, { name: "Keyboard view", shared: true });
  await openBoard(page);

  await trigger(page).focus();
  await page.keyboard.press("Enter");
  await expect(menu(page)).toBeVisible();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => menu(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);

  await expect(menu(page).getByRole("button", { name: "Keyboard view" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(menu(page).getByRole("button", { name: "Keyboard view" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(menu(page).getByRole("button", { name: "Copy link" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
});

test("a view is applied from the keyboard alone, and focus returns to the button", async ({ page, request }) => {
  await createView(request, PROJECT_KEY, { name: "Urgent only", viewMode: "list", filters: { priority: "urgent" } });
  await request.put(`/api/projects/${PROJECT_KEY}/tasks/${HELD_TASK_ID}`, { headers: ADMIN_AUTH, data: { priority: "urgent" } });
  await openBoard(page);

  await trigger(page).focus();
  await page.keyboard.press("Enter");
  await menu(page).getByRole("button", { name: "Urgent only" }).focus();
  await page.keyboard.press("Enter");

  await expect(menu(page)).toHaveCount(0);
  await expect(page.locator("table")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Filters/ })).toContainText("1");
  await expect(rows(page)).toHaveCount(1);
  await expect(trigger(page)).toBeFocused();
});

test("on a phone the menu stays inside the screen, and nothing scrolls the page sideways", async ({ page, request }) => {
  await createView(request, PROJECT_KEY, { name: "A view with a rather long name that has to be cut somewhere sensible", shared: true });
  await page.setViewportSize({ width: 390, height: 800 });
  await openBoard(page);
  await trigger(page).click();
  await expect(menu(page)).toBeVisible();

  const box = (await menu(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(await menu(page).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  expect(await page.locator("#main-content").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  const save = menu(page).getByRole("button", { name: "Save view" });
  await save.scrollIntoViewIfNeeded();
  const reach = (await save.boundingBox())!;
  expect(reach.x + reach.width).toBeLessThanOrEqual(390);
});

test("the menu is readable in the dark theme", async ({ page, request }) => {
  await createView(request, PROJECT_KEY, { name: "Dark view", shared: true });
  await openBoard(page);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await trigger(page).click();
  await expect(menu(page)).toBeVisible();
  await page.mouse.move(0, 0);

  for (const target of [menu(page).getByRole("button", { name: "Dark view" }), menu(page).getByText("Save what is on screen as a view")]) {
    await expect(target).toBeVisible();
    const painted = await target.evaluate((element) => {
      const backgrounds: string[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        backgrounds.push(getComputedStyle(node).backgroundColor);
      }
      return { color: getComputedStyle(element).color, backgrounds };
    });
    expect(textContrast(painted)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(surfaceLuminance(painted.backgrounds)).toBeLessThanOrEqual(DARK_SURFACE_MAX_LUMINANCE);
  }
});

test("a ?view= link opened while signed out survives the sign-in and applies the view", async ({ page, request }) => {
  const shared = await createView(request, PROJECT_KEY, { name: "Urgent only", shared: true, viewMode: "list", filters: { priority: "urgent" } });
  await request.put(`/api/projects/${PROJECT_KEY}/tasks/${HELD_TASK_ID}`, { headers: ADMIN_AUTH, data: { priority: "urgent" } });

  await page.goto(`${BOARD}?view=${shared._id}`);
  await expect(page).toHaveURL(/\/login\?next=/);
  expect(decodeURIComponent(new URL(page.url()).searchParams.get("next") ?? "")).toContain(`view=${shared._id}`);

  await page.getByLabel("Username").fill(ADMIN_USERNAME);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();

  await expect(page.locator("table")).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByText(HELD_TASK_TITLE).first()).toBeVisible();
  expect(new URL(page.url()).searchParams.has("view")).toBe(false);
});

test("a view that belongs to another board is not opened here, and says so", async ({ page, request }) => {
  await seedSecondProject();
  const elsewhere = await createView(request, SECOND_PROJECT_KEY, { name: "Other board's view", shared: true, viewMode: "list", filters: { priority: "urgent" } });
  await signIn(page);

  const listed = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${PROJECT_KEY}/views`) && r.request().method() === "GET");
  await page.goto(`${BOARD}?view=${elsewhere._id}`);
  await listed;

  await expect(page.getByText("That view is gone")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Filters/ })).not.toContainText(/\b[1-9]\b/);
  expect(new URL(page.url()).searchParams.has("view")).toBe(false);
  await expect(page.locator("table")).toHaveCount(0);
});

test("two tabs saving the same name at once keep one view, and the other tab is told why", async ({ browser, request }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const pages = await Promise.all(
      contexts.map(async (context) => {
        await signInContext(context, "admin");
        const page = await context.newPage();
        await page.goto(BOARD);
        await trigger(page).click();
        await menu(page).getByLabel("View name").fill("Same name");
        return page;
      })
    );

    await Promise.all(pages.map((page) => menu(page).getByRole("button", { name: "Save view" }).click()));

    await expect.poll(async () => (await (await request.get(`/api/projects/${PROJECT_KEY}/views`, { headers: ADMIN_AUTH })).json()).length).toBe(1);
    const refusals = async () => {
      const found: string[] = [];
      for (const page of pages) {
        const alert = menu(page).getByRole("alert");
        if ((await alert.count()) > 0) found.push((await alert.textContent()) ?? "");
      }
      return found.filter((m) => m.includes("already exists")).length;
    };
    await expect.poll(refusals).toBe(1);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
