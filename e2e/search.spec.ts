import { test, expect, type Page } from "@playwright/test";
import {
  ABSENT_WORD,
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  BODY_HIT_NUMBER,
  BODY_HIT_TITLE,
  HELD_TASK_TITLE,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  OTHER_HIT_KEY,
  OTHER_HIT_TITLE,
  OTHER_PROJECT_NAME,
  PROJECT_KEY,
  PROJECT_NAME,
  SEARCH_WORD,
  TITLE_HIT_NUMBER,
  TITLE_HIT_TITLE,
  seed,
  seedSearchCorpus,
} from "./seed";

/**
 * BP-386. Two readers, one query: the admin reaches both boards, the member holds a grant on TP
 * only, and SEARCH_WORD matches a task on each. Every leak assertion below is paired with the
 * admin control that sees the same task — a silent list caused by a mis-wired fixture reads
 * exactly like a silent list caused by the filter.
 *
 * The /search page has no filter controls: it is a query box, a grouped result list and the three
 * states around them. The task's "page filters" is covered as the only filtering that page
 * performs — by grant, and by the query itself — because there is nothing else there to drive.
 */

const TITLE_HIT_KEY = `${PROJECT_KEY}-${TITLE_HIT_NUMBER}`;
const BODY_HIT_KEY = `${PROJECT_KEY}-${BODY_HIT_NUMBER}`;

async function signIn(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);
}

const layerOf = (page: Page) => page.getByRole("dialog", { name: "Search" });

/**
 * The ⌘K listener is registered in a client effect, so the shortcut does nothing against a page
 * that has merely been painted. The board's cards arrive from a client fetch, which is what says
 * React is running here — five tests failed on the race before this wait existed.
 */
async function openBoard(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByText(HELD_TASK_TITLE).first()).toBeVisible();
}

async function openLayer(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  const layer = layerOf(page);
  await expect(layer).toBeVisible();
  return layer;
}

/**
 * Results render optimistically off whatever the hook is holding, so the text is on screen before
 * the server has answered. Every query below waits for the response it is actually about.
 */
async function query(page: Page, text: string) {
  const answered = page.waitForResponse(
    (r) => r.url().includes("/api/search?q=") && r.request().method() === "GET"
  );
  await layerOf(page).getByLabel("Search tasks and projects").fill(text);
  await answered;
}

const options = (page: Page) => layerOf(page).getByRole("option");

test.beforeEach(async () => {
  await seed();
  await seedSearchCorpus();
});

test.describe("the ⌘K layer", () => {
  test("opens on ⌘K, closes on Escape, and reopens on /", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);

    await openLayer(page);
    // Nothing typed yet: the layer says what it wants rather than showing an empty list
    await expect(layerOf(page).getByText("Type at least 2 characters to search")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(layerOf(page)).toBeHidden();

    // The other way in, and the one that would break if the shortcut handler stopped
    // distinguishing a typing target from the page
    await page.keyboard.press("/");
    await expect(layerOf(page)).toBeVisible();
  });

  test("one character is still the empty state; two search", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    const input = layerOf(page).getByLabel("Search tasks and projects");
    let requested = false;
    page.on("request", (r) => {
      if (r.url().includes("/api/search?q=")) requested = true;
    });

    await input.fill("z");
    await expect(layerOf(page).getByText("Type at least 2 characters to search")).toBeVisible();
    // Long enough for the 250ms debounce to have fired if the floor were not enforced
    await page.waitForTimeout(1_000);
    expect(requested).toBe(false);

    await query(page, SEARCH_WORD);
    await expect(options(page).first()).toBeVisible();
    expect(requested).toBe(true);
  });

  test("finds a task by title, by body, and by key", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    // Stored capitalised, queried lower case
    await query(page, SEARCH_WORD);
    await expect(options(page).filter({ hasText: TITLE_HIT_TITLE })).toHaveCount(1);
    // Carries the word only in its description
    await expect(options(page).filter({ hasText: BODY_HIT_TITLE })).toHaveCount(1);

    await query(page, TITLE_HIT_KEY);
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText(TITLE_HIT_TITLE);
  });

  test("↑↓ move the cursor and Enter opens what it is on", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);
    await query(page, SEARCH_WORD);

    // Newest first, and this board's hits before the other board's
    await expect(options(page).nth(0)).toContainText(TITLE_HIT_TITLE);
    await expect(options(page).nth(1)).toContainText(BODY_HIT_TITLE);
    await expect(options(page).nth(0)).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("ArrowDown");
    await expect(options(page).nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(options(page).nth(0)).toHaveAttribute("aria-selected", "false");

    await page.keyboard.press("ArrowUp");
    await expect(options(page).nth(0)).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/tasks/${BODY_HIT_NUMBER}$`));
    await expect(layerOf(page)).toBeHidden();
  });

  test("Enter without arrowing opens the first hit", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);
    await query(page, SEARCH_WORD);

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/tasks/${TITLE_HIT_NUMBER}$`));
  });

  test("a word nothing carries says so", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    await query(page, ABSENT_WORD);
    await expect(layerOf(page).getByText("No matches")).toBeVisible();
    await expect(options(page)).toHaveCount(0);
  });

  test("the admin sees the other board's task", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);
    await query(page, SEARCH_WORD);

    await expect(options(page).filter({ hasText: OTHER_HIT_TITLE })).toHaveCount(1);
    await expect(layerOf(page).getByText("Other projects")).toBeVisible();
  });

  test("the member, with no grant on it, does not", async ({ page }) => {
    await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
    await openBoard(page);
    await openLayer(page);
    await query(page, SEARCH_WORD);

    // The two this reader may see, so the absence below is a filtered list and not an empty one
    await expect(options(page).filter({ hasText: TITLE_HIT_TITLE })).toHaveCount(1);
    await expect(options(page).filter({ hasText: BODY_HIT_TITLE })).toHaveCount(1);

    await expect(options(page).filter({ hasText: OTHER_HIT_TITLE })).toHaveCount(0);
    await expect(layerOf(page).getByText("Other projects")).toBeHidden();
  });

  test("the member cannot reach the other board by its key either", async ({ page }) => {
    await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    // The key path is a separate branch of the endpoint, with its own copy of the filter
    await query(page, TITLE_HIT_KEY);
    await expect(options(page)).toHaveCount(1);

    await query(page, OTHER_HIT_KEY);
    await expect(layerOf(page).getByText("No matches")).toBeVisible();
    await expect(options(page)).toHaveCount(0);
  });
});

test.describe("the /search page", () => {
  const results = (page: Page) => page.getByRole("main").getByRole("link");

  test("a ?q link arrives with its results already grouped by project", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const answered = page.waitForResponse((r) => r.url().includes("/api/search?q="));
    await page.goto(`/search?q=${SEARCH_WORD}`);
    await answered;

    await expect(page.getByRole("heading", { name: new RegExp(PROJECT_NAME) })).toBeVisible();
    await expect(page.getByRole("heading", { name: new RegExp(OTHER_PROJECT_NAME) })).toBeVisible();

    await expect(results(page).filter({ hasText: TITLE_HIT_TITLE })).toHaveCount(1);
    await expect(results(page).filter({ hasText: OTHER_HIT_TITLE })).toHaveCount(1);
  });

  test("a result opens the task it names", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    const answered = page.waitForResponse((r) => r.url().includes("/api/search?q="));
    await page.goto(`/search?q=${SEARCH_WORD}`);
    await answered;

    await results(page).filter({ hasText: BODY_HIT_TITLE }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/tasks/${BODY_HIT_NUMBER}$`));
    await expect(page.getByText(BODY_HIT_TITLE).first()).toBeVisible();
  });

  test("typing a query and submitting it puts the query in the address", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/search");

    const input = page.getByPlaceholder("Search tasks by title, description, or key");
    const answered = page.waitForResponse((r) => r.url().includes("/api/search?q="));
    await input.fill(BODY_HIT_KEY);
    await input.press("Enter");
    await answered;

    await expect(page).toHaveURL(new RegExp(`/search\\?q=${PROJECT_KEY}-${BODY_HIT_NUMBER}$`));
    await expect(results(page)).toHaveCount(1);
    await expect(results(page).first()).toContainText(BODY_HIT_TITLE);
  });

  test("a one-character query is not submitted at all", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/search");

    let requested = false;
    page.on("request", (r) => {
      if (r.url().includes("/api/search?q=")) requested = true;
    });

    const input = page.getByPlaceholder("Search tasks by title, description, or key");
    await input.fill("z");
    await input.press("Enter");
    await page.waitForTimeout(1_000);

    expect(requested).toBe(false);
    await expect(page).toHaveURL(/\/search$/);
    await expect(page.getByText("No tasks found")).toBeHidden();
  });

  test("a word nothing carries says so", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    const answered = page.waitForResponse((r) => r.url().includes("/api/search?q="));
    await page.goto(`/search?q=${ABSENT_WORD}`);
    await answered;

    await expect(page.getByText("No tasks found")).toBeVisible();
    await expect(results(page)).toHaveCount(0);
  });

  test("the member's results stop at the board they hold a grant on", async ({ page }) => {
    await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
    const answered = page.waitForResponse((r) => r.url().includes("/api/search?q="));
    await page.goto(`/search?q=${SEARCH_WORD}`);
    await answered;

    await expect(page.getByRole("heading", { name: new RegExp(PROJECT_NAME) })).toBeVisible();
    await expect(results(page).filter({ hasText: TITLE_HIT_TITLE })).toHaveCount(1);

    await expect(
      page.getByRole("heading", { name: new RegExp(OTHER_PROJECT_NAME) })
    ).toBeHidden();
    await expect(results(page).filter({ hasText: OTHER_HIT_TITLE })).toHaveCount(0);
  });
});
