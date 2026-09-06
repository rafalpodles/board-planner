import { test, expect, type Page } from "@playwright/test";
import { PROJECT_KEY, DECOY_TASK_NUMBER, SIBLING_TASK_NUMBER, seed } from "./seed";
import { signIn } from "./session";

test.beforeEach(seed);

const help = (page: Page) => page.getByRole("heading", { name: "Keyboard Shortcuts" });

const newTask = (page: Page) => page.getByRole("dialog", { name: "New Task" });

const cardFor = (page: Page, taskNumber: number) =>
  page.locator(`a[href="/projects/${PROJECT_KEY}/tasks/${taskNumber}"]`);

const card = (page: Page) => cardFor(page, DECOY_TASK_NUMBER);

const contextMenu = (page: Page) => page.getByTestId("task-context-menu");

const selectBox = (page: Page) =>
  page.getByRole("button", { name: `Select ${PROJECT_KEY}-${DECOY_TASK_NUMBER}` });

const focused = (page: Page) => page.locator(":focus");

async function freezeBoardPolling(page: Page) {
  await page.route(
    (url) => /\/api\/projects\/[^/]+\/tasks(\?|$)/.test(url.pathname + url.search),
    (route) => {
      if (route.request().method() !== "GET") return route.continue();
    }
  );
}

async function openBoard(page: Page) {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(card(page)).toBeVisible();
  await freezeBoardPolling(page);
}

test("Escape closes the keyboard-shortcuts help", async ({ page }) => {
  await openBoard(page);

  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(help(page)).toBeHidden();
});

test("Escape closes the New Task modal", async ({ page }) => {
  await openBoard(page);

  await page.keyboard.press("n");
  await expect(newTask(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(newTask(page)).toBeHidden();
});

test("the board's own ? toggle still closes the help — the control for the press that worked", async ({
  page,
}) => {
  await openBoard(page);

  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();

  await page.keyboard.press("?");
  await expect(help(page)).toBeHidden();
});

test("Escape still clears a card selection when no dialog is open", async ({ page }) => {
  await openBoard(page);

  await card(page).click({ modifiers: ["Shift"] });
  await expect(selectBox(page)).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press("Escape");
  await expect(card(page)).toBeVisible();
  await expect(selectBox(page)).toBeHidden();
});

test("Escape closes the card's context menu", async ({ page }) => {
  await openBoard(page);

  await card(page).click({ button: "right" });
  await expect(contextMenu(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(contextMenu(page)).toBeHidden();
});

test("Escape closes the bulk-delete confirm and leaves the selection it is about", async ({
  page,
}) => {
  await openBoard(page);

  await card(page).click({ modifiers: ["Shift"] });
  await cardFor(page, SIBLING_TASK_NUMBER).click({ modifiers: ["Shift"] });
  await card(page).click({ button: "right" });
  await page.getByRole("button", { name: /^Delete 2 tasks/ }).click();

  const confirm = page.getByRole("dialog", { name: "Delete Selected Tasks" });
  await expect(confirm).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(selectBox(page)).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: `Select ${PROJECT_KEY}-${SIBLING_TASK_NUMBER}` })
  ).toHaveAttribute("aria-pressed", "true");
});

test("? still closes the help after a reload has reordered the listeners", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(card(page)).toBeVisible();

  await page.evaluate(() => {
    const w = window as unknown as { __keydownSubs: number };
    w.__keydownSubs = 0;
    const add = document.addEventListener.bind(document);
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === "keydown") w.__keydownSubs += 1;
      return (add as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof document.addEventListener;
  });

  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();

  const before = await page.evaluate(
    () => (window as unknown as { __keydownSubs: number }).__keydownSubs
  );
  await page.keyboard.press("r");
  await page.waitForFunction(
    (n) => (window as unknown as { __keydownSubs: number }).__keydownSubs > n,
    before
  );

  await page.keyboard.press("?");
  await expect(help(page)).toBeHidden();
});

const helpDialog = (page: Page) => page.getByRole("dialog", { name: "Keyboard Shortcuts" });

const activeElementIsInsideTheHelp = (page: Page) =>
  helpDialog(page).evaluate((el) => el.contains(document.activeElement));

const scrollLock = (page: Page) => page.evaluate(() => document.body.style.overflow);

const collapseSidebar = (page: Page) =>
  page.getByRole("button", { name: /(Collapse|Expand) sidebar/ });

test("the help announces as a dialog named after its heading", async ({ page }) => {
  await openBoard(page);

  await page.keyboard.press("?");
  await expect(helpDialog(page)).toBeVisible();
});

test("focus moves into the help and Tab never reaches the sidebar behind it", async ({ page }) => {
  await openBoard(page);

  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();
  await expect.poll(() => activeElementIsInsideTheHelp(page)).toBe(true);

  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    await expect.poll(() => activeElementIsInsideTheHelp(page)).toBe(true);
  }

  await expect(collapseSidebar(page)).toBeVisible();
});

test("the page behind the help does not scroll, and scrolls again once it closes", async ({
  page,
}) => {
  await openBoard(page);

  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();
  await expect.poll(() => scrollLock(page)).toBe("hidden");

  await page.keyboard.press("Escape");
  await expect(help(page)).toBeHidden();
  await expect.poll(() => scrollLock(page)).toBe("");
});

test("Escape closes the help without also clearing the selection underneath it", async ({
  page,
}) => {
  await openBoard(page);

  await card(page).click({ modifiers: ["Shift"] });
  await expect(selectBox(page)).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(help(page)).toBeHidden();
  await expect(selectBox(page)).toHaveAttribute("aria-pressed", "true");
});

test("Escape closes the help even when a context menu closes on the same press", async ({
  page,
}) => {
  await openBoard(page);

  await card(page).click({ button: "right" });
  await expect(contextMenu(page)).toBeVisible();
  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(contextMenu(page)).toBeHidden();
  await expect(help(page)).toBeHidden();
});

const boardToggle = (page: Page) => page.getByRole("button", { name: "Board", exact: true });

test("j then Enter does not navigate away from under the help", async ({ page }) => {
  await openBoard(page);

  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();

  const navigatedToATask = page
    .waitForResponse((res) => new RegExp(`/projects/${PROJECT_KEY}/tasks/\\d+`).test(res.url()), {
      timeout: 2_000,
    })
    .then(() => true)
    .catch(() => false);

  await page.keyboard.press("j");
  await page.keyboard.press("Enter");

  expect(await navigatedToATask).toBe(false);
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
  await expect(help(page)).toBeVisible();

  await page.keyboard.press("?");
  await expect(help(page)).toBeHidden();
});

test("v does not toggle the view behind the help", async ({ page }) => {
  await openBoard(page);
  await expect(boardToggle(page)).toHaveAttribute("aria-current", "true");

  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();

  await page.keyboard.press("v");
  await expect(boardToggle(page)).toHaveAttribute("aria-current", "true");
  await expect(help(page)).toBeVisible();

  await page.keyboard.press("?");
  await expect(help(page)).toBeHidden();
});

test.describe("the help's content overflows the dialog", () => {
  test.use({ viewport: { width: 1280, height: 700 } });

  test("Tab reaches the scroll container, and PageDown scrolls it", async ({ page }) => {
    await openBoard(page);

    await page.keyboard.press("?");
    await expect(help(page)).toBeVisible();

    await page.keyboard.press("Tab");
    await expect(focused(page)).toHaveAccessibleName("Close dialog");

    await page.keyboard.press("Tab");
    const scroller = focused(page);
    await expect(scroller).toHaveJSProperty("scrollTop", 0);

    await page.keyboard.press("PageDown");
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });
});

test("a dialog that never overflows gets no extra tab stop", async ({ page }) => {
  await openBoard(page);

  await card(page).click({ modifiers: ["Shift"] });
  await cardFor(page, SIBLING_TASK_NUMBER).click({ modifiers: ["Shift"] });
  await card(page).click({ button: "right" });
  await page.getByRole("button", { name: /^Delete 2 tasks/ }).click();

  const confirm = page.getByRole("dialog", { name: "Delete Selected Tasks" });
  await expect(confirm).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(focused(page)).toHaveAccessibleName("Close dialog");

  await page.keyboard.press("Tab");
  await expect(focused(page)).toHaveAccessibleName("Cancel");
});

const searchLayer = (page: Page) => page.getByRole("dialog", { name: "Search" });

for (const [label, key] of [
  ["/", "/"],
  ["⌘K", "ControlOrMeta+k"],
] as const) {
  test(`${label} does not open Search over the help`, async ({ page }) => {
    await openBoard(page);

    await page.keyboard.press("?");
    await expect(help(page)).toBeVisible();
    await expect.poll(() => activeElementIsInsideTheHelp(page)).toBe(true);

    await page.keyboard.press(key);
    await expect(searchLayer(page)).toHaveCount(0);
    await expect.poll(() => activeElementIsInsideTheHelp(page)).toBe(true);
    await expect(help(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(help(page)).toBeHidden();
    await expect.poll(() => scrollLock(page)).toBe("");
    await page.keyboard.press(key);
    await expect(searchLayer(page)).toBeVisible();
  });
}

test("⌘K does not open Search over the New Task form, cursor in the title", async ({ page }) => {
  await openBoard(page);

  await page.keyboard.press("n");
  await expect(newTask(page)).toBeVisible();
  const title = newTask(page).getByLabel("Title", { exact: true });
  await title.click();
  await expect(title).toBeFocused();

  await page.keyboard.press("ControlOrMeta+k");
  await expect(searchLayer(page)).toHaveCount(0);
  await expect(title).toBeFocused();
  await expect(newTask(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(newTask(page)).toBeHidden();
  await expect.poll(() => scrollLock(page)).toBe("");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(searchLayer(page)).toBeVisible();
});

test("⌘K still closes the Search it opened", async ({ page }) => {
  await openBoard(page);

  await page.keyboard.press("ControlOrMeta+k");
  await expect(searchLayer(page)).toBeVisible();
  await expect.poll(() => scrollLock(page)).toBe("hidden");

  await page.keyboard.press("ControlOrMeta+k");
  await expect(searchLayer(page)).toBeHidden();
});
