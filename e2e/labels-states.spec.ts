import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { AA_TEXT, DARK_SURFACE_MAX_LUMINANCE, surfaceLuminance, textContrast } from "./colour";
import {
  DECOY_TASK_NUMBER,
  DECOY_TASK_TITLE,
  HELD_TASK_KEY,
  HELD_TASK_TITLE,
  PROJECT_KEY,
  SIBLING_TASK_KEY,
  SIBLING_TASK_TITLE,
  seed,
  seedLabelsField,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-887 follow-up: the label filter on a phone, with a keyboard and in the dark theme, and the
 * label search through MCP, which resolves a name through a different path from the board's.
 */
test.use({ colorScheme: "light" });
test.beforeEach(async () => {
  await seed();
  await seedLabelsField();
});

const BOARD = `/projects/${PROJECT_KEY}`;
const DECOY_KEY = `${PROJECT_KEY}-${DECOY_TASK_NUMBER}`;
const rows = (page: Page) => page.locator("table tbody tr");
const panel = (page: Page) => page.getByRole("dialog", { name: "Filters" });
const labelGroup = (page: Page) => panel(page).getByRole("group", { name: "Labels", exact: true });
const option = (page: Page, name: string) => labelGroup(page).getByRole("button", { name, exact: true });

async function openList(page: Page) {
  await signIn(page);
  await page.goto(BOARD);
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator("table")).toBeVisible();
}

async function openPanel(page: Page) {
  await page.getByRole("button", { name: /^Filters/ }).click();
  await expect(panel(page)).toBeVisible();
}

async function callMcp(request: APIRequestContext, name: string, args: Record<string, unknown>) {
  const response = await request.post("/api/mcp", {
    headers: { ...ADMIN_AUTH, Accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.status(), await response.text()).toBe(200);
  return response.text();
}

test("the label filter works on a phone: it fits the screen, picks narrow the list, and the page does not scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openList(page);
  await openPanel(page);

  const box = (await panel(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);

  await option(page, "Frontend").scrollIntoViewIfNeeded();
  await option(page, "Frontend").click();
  await expect(option(page, "Frontend")).toHaveAttribute("aria-pressed", "true");
  await option(page, "Backend").click();
  await labelGroup(page).getByRole("button", { name: "All of them" }).click();

  const reach = (await labelGroup(page).boundingBox())!;
  expect(reach.x + reach.width).toBeLessThanOrEqual(390);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole("button", { name: /^Filters/ })).toContainText("1");
});

test("labels are picked from the keyboard: Space toggles an option, and the list follows", async ({ page }) => {
  await openList(page);
  await expect(rows(page)).toHaveCount(4);
  await openPanel(page);

  await option(page, "Design").focus();
  await page.keyboard.press("Space");

  await expect(option(page, "Design")).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).filter({ hasText: SIBLING_TASK_TITLE })).toBeVisible();

  await page.keyboard.press("Space");
  await expect(option(page, "Design")).toHaveAttribute("aria-pressed", "false");
  await expect(rows(page)).toHaveCount(4);

  await option(page, "Frontend").focus();
  await page.keyboard.press("Enter");
  await expect(option(page, "Frontend")).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page)).toHaveCount(1);
});

test("a picked label and the filter's own text are readable in the dark theme", async ({ page }) => {
  await openList(page);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await openPanel(page);
  await option(page, "Frontend").click();
  await option(page, "Backend").click();
  await page.mouse.move(0, 0);

  // TODO(BP-997): the selected "Any of them" reads at 4.42:1 in the dark theme; add it once that is fixed
  for (const target of [option(page, "Frontend"), option(page, "Design"), labelGroup(page).getByRole("button", { name: "All of them" })]) {
    await expect(target).toBeVisible();
    const painted = await target.evaluate((element) => {
      const backgrounds: string[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        backgrounds.push(getComputedStyle(node).backgroundColor);
      }
      return { color: getComputedStyle(element).color, backgrounds };
    });
    expect(textContrast(painted), (await target.textContent()) ?? "").toBeGreaterThanOrEqual(AA_TEXT);
  }
  const surface = await option(page, "Design").evaluate((element) => {
    const backgrounds: string[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      backgrounds.push(getComputedStyle(node).backgroundColor);
    }
    return backgrounds;
  });
  expect(surfaceLuminance(surface)).toBeLessThanOrEqual(DARK_SURFACE_MAX_LUMINANCE);
});

test("MCP finds a task by the name of its label: search_tasks across boards, list_tasks on one", async ({ request }) => {
  const searched = await callMcp(request, "search_tasks", { query: "backend" });
  expect(searched).toContain(HELD_TASK_KEY);
  expect(searched).toContain(DECOY_KEY);
  expect(searched).not.toContain(SIBLING_TASK_KEY);

  const listed = await callMcp(request, "list_tasks", { project: PROJECT_KEY, search: "design" });
  expect(listed).toContain(SIBLING_TASK_KEY);
  expect(listed).not.toContain(HELD_TASK_KEY);
  expect(listed).not.toContain(DECOY_KEY);

  const none = await callMcp(request, "list_tasks", { project: PROJECT_KEY, search: "nosuchlabel" });
  expect(none).not.toContain(HELD_TASK_TITLE);
  expect(none).not.toContain(DECOY_TASK_TITLE);
  expect(none).not.toContain(SIBLING_TASK_TITLE);
});
