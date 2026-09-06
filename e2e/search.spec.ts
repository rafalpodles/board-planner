import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  ABSENT_WORD,
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  BODY_HIT_NUMBER,
  BODY_HIT_TITLE,
  BODY_ONLY_WORD,
  HELD_TASK_TITLE,
  HELD_TASK_KEY,
  LEGACY_HIT_KEY,
  LEGACY_HIT_TITLE,
  LEGACY_HIT_WORD,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  META_HIT_TITLE,
  META_QUERY,
  META_WILDCARD,
  OTHER_HIT_KEY,
  OTHER_HIT_TITLE,
  OTHER_PROJECT_KEY,
  OTHER_PROJECT_NAME,
  PROJECT_KEY,
  PROJECT_NAME,
  SEARCH_WORD,
  TITLE_HIT_NUMBER,
  TITLE_HIT_TITLE,
  seed,
  seedSearchCorpus,
} from "./seed";
import { signIn as arriveSignedIn, signInThroughForm } from "./session";

const TITLE_HIT_KEY = `${PROJECT_KEY}-${TITLE_HIT_NUMBER}`;
const BODY_HIT_KEY = `${PROJECT_KEY}-${BODY_HIT_NUMBER}`;

const searchFor = (text: string) => (r: { url(): string; status(): number }) => {
  const url = new URL(r.url());
  return (
    url.pathname === "/api/search" && url.searchParams.get("q") === text && r.status() === 200
  );
};

const searchRequestFor = (text: string) => (url: string) => {
  const parsed = new URL(url);
  return parsed.pathname === "/api/search" && parsed.searchParams.get("q") === text;
};

const signIn = (page: Page, username: string, password: string) =>
  username === ADMIN_USERNAME
    ? arriveSignedIn(page)
    : username === MEMBER_USERNAME
      ? arriveSignedIn(page, "member")
      : signInThroughForm(page, username, password);

const layerOf = (page: Page) => page.getByRole("dialog", { name: "Search" });
const options = (page: Page) => layerOf(page).getByRole("option");
const layerInput = (page: Page) => layerOf(page).getByLabel("Search tasks and projects");

async function openBoard(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByText(HELD_TASK_TITLE).first()).toBeVisible();
}

async function openSearchPage(page: Page, url = "/search") {
  await page.goto(url);
  await expect(page.getByPlaceholder("Search tasks by title, description, or key")).toBeVisible();
}

async function openLayer(page: Page) {
  await page.mouse.move(0, 0);
  await page.keyboard.press("ControlOrMeta+k");
  const layer = layerOf(page);
  await expect(layer).toBeVisible();
  return layer;
}

async function query(page: Page, text: string) {
  const answered = page.waitForResponse(searchFor(text));
  await layerInput(page).fill(text);
  await answered;
}

test.beforeEach(async () => {
  await seed();
  await seedSearchCorpus();
});

test.describe("the ⌘K layer", () => {
  test("opens on ⌘K, toggles closed on ⌘K, closes on Escape, and reopens on /", async ({
    page,
  }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);

    await openLayer(page);
    await expect(layerOf(page).getByText("Type at least 2 characters to search")).toBeVisible();

    await page.keyboard.press("ControlOrMeta+k");
    await expect(layerOf(page)).toBeHidden();

    await openLayer(page);
    await page.keyboard.press("Escape");
    await expect(layerOf(page)).toBeHidden();

    await page.keyboard.press("/");
    await expect(layerOf(page)).toBeVisible();
  });

  test("/ pressed inside a text field types, and does not open the layer", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openSearchPage(page);

    const input = page.getByPlaceholder("Search tasks by title, description, or key");

    await page.getByRole("heading", { name: "Search" }).click();
    await page.keyboard.press("/");
    await expect(layerOf(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(layerOf(page)).toBeHidden();

    await input.click();
    await page.keyboard.press("/");

    await expect(layerOf(page)).toBeHidden();
    await expect(input).toHaveValue("/");
  });

  test("one character is still the empty state; two search", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    let requested = false;
    page.on("request", (r) => {
      if (searchRequestFor("z")(r.url())) requested = true;
    });

    await layerInput(page).fill("z");
    await expect(layerOf(page).getByText("Type at least 2 characters to search")).toBeVisible();
    await page.waitForTimeout(1_000);

    await query(page, SEARCH_WORD);
    await expect(options(page).first()).toBeVisible();
    expect(requested).toBe(false);
  });

  test("finds a task by title, by body, and by key", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    await query(page, SEARCH_WORD);
    await expect(options(page).filter({ hasText: TITLE_HIT_TITLE })).toHaveCount(1);
    await expect(options(page).filter({ hasText: BODY_HIT_TITLE })).toHaveCount(1);

    await query(page, TITLE_HIT_KEY);
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText(TITLE_HIT_TITLE);
  });

  test("a query made of regex metacharacters is matched literally", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    await query(page, META_QUERY);
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText(META_HIT_TITLE);

    await query(page, META_WILDCARD);
    await expect(layerOf(page).getByText("No matches")).toBeVisible();
  });

  test("↑↓ move the cursor and Enter opens what it is on", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);
    await query(page, SEARCH_WORD);

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

    await expect(options(page).nth(0)).toContainText(TITLE_HIT_TITLE);

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/tasks/${TITLE_HIT_NUMBER}$`));
  });

  test("clicking a hit opens it too", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);
    await query(page, SEARCH_WORD);

    await options(page).filter({ hasText: BODY_HIT_TITLE }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/tasks/${BODY_HIT_NUMBER}$`));
  });

  test("a word nothing carries says so", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    await query(page, ABSENT_WORD);
    await expect(layerOf(page).getByText("No matches")).toBeVisible();
  });

  test("See all results carries the query to the page", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);
    await query(page, SEARCH_WORD);

    const arrived = page.waitForResponse(searchFor(SEARCH_WORD));
    await layerOf(page).getByRole("link", { name: "See all results" }).click();
    await arrived;

    await expect(page).toHaveURL(new RegExp(`/search\\?q=${SEARCH_WORD}$`));
    await expect(layerOf(page)).toBeHidden();
    await expect(page.getByRole("main").getByText(TITLE_HIT_TITLE)).toBeVisible();
  });

  test("a description-only hit on the other board is reachable by the admin", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    await query(page, BODY_ONLY_WORD);
    await expect(options(page).filter({ hasText: BODY_HIT_TITLE })).toHaveCount(1);
    await expect(options(page).filter({ hasText: OTHER_HIT_TITLE })).toHaveCount(1);
  });

  test("and is not reachable by the member, on that same query", async ({ page }) => {
    await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    await query(page, BODY_ONLY_WORD);
    await expect(options(page).filter({ hasText: BODY_HIT_TITLE })).toHaveCount(1);
    await expect(options(page).filter({ hasText: OTHER_HIT_TITLE })).toHaveCount(0);
  });

  test("the admin sees the other board's task, under its own heading", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);
    await query(page, SEARCH_WORD);

    await expect(options(page).filter({ hasText: OTHER_HIT_TITLE })).toHaveCount(1);
    await expect(layerOf(page).getByText("In this project")).toBeVisible();
    await expect(layerOf(page).getByText("Other projects")).toBeVisible();
  });

  test("the member, with no grant on it, does not", async ({ page }) => {
    await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
    await openBoard(page);
    await openLayer(page);
    await query(page, SEARCH_WORD);

    await expect(options(page).filter({ hasText: TITLE_HIT_TITLE })).toHaveCount(1);
    await expect(options(page).filter({ hasText: BODY_HIT_TITLE })).toHaveCount(1);

    await expect(options(page).filter({ hasText: OTHER_HIT_TITLE })).toHaveCount(0);
    await expect(layerOf(page).getByText("Other projects")).toBeHidden();
  });

  test("a key lookup does not reach the same number on another board", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    await query(page, HELD_TASK_KEY);
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText(HELD_TASK_TITLE);
    await expect(options(page).filter({ hasText: OTHER_HIT_TITLE })).toHaveCount(0);
  });

  test("the member cannot reach the other board by its key either", async ({ page }) => {
    await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    await query(page, TITLE_HIT_KEY);
    await expect(options(page)).toHaveCount(1);

    await query(page, OTHER_HIT_KEY);
    await expect(layerOf(page).getByText("No matches")).toBeVisible();
  });

  test("the key the member cannot use does resolve for the admin", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    await query(page, OTHER_HIT_KEY);
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText(OTHER_HIT_TITLE);
  });

  const BOTH_SURFACES = "board";

  test("one query, both surfaces: the admin sees the other project and its task", async ({
    page,
  }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    await query(page, BOTH_SURFACES);
    await expect(options(page)).toHaveCount(3);
    await expect(options(page).filter({ hasText: PROJECT_NAME })).toHaveCount(1);
    await expect(options(page).filter({ hasText: OTHER_PROJECT_NAME })).toHaveCount(1);
    await expect(options(page).filter({ hasText: OTHER_HIT_TITLE })).toHaveCount(1);

    await options(page).filter({ hasText: OTHER_PROJECT_NAME }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${OTHER_PROJECT_KEY}$`));
  });

  test("one query, both surfaces: the member sees only their own", async ({ page }) => {
    await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    await query(page, BOTH_SURFACES);
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText(PROJECT_NAME);
    await expect(options(page).filter({ hasText: OTHER_PROJECT_NAME })).toHaveCount(0);
    await expect(options(page).filter({ hasText: OTHER_HIT_TITLE })).toHaveCount(0);
  });
});

test.describe("the /search page", () => {
  const pageInput = (page: Page) =>
    page.getByPlaceholder("Search tasks by title, description, or key");

  const group = (page: Page, projectName: string): Locator =>
    page
      .getByRole("heading", { name: new RegExp(projectName) })
      .locator("xpath=following-sibling::div[1]");

  const results = (page: Page) => page.getByRole("main").getByRole("link");

  async function arriveWith(page: Page, q: string) {
    const answered = page.waitForResponse(searchFor(q));
    await page.goto(`/search?q=${encodeURIComponent(q)}`);
    await answered;
  }

  test("a ?q link arrives with its results already under the right project", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await arriveWith(page, SEARCH_WORD);

    await expect(group(page, PROJECT_NAME).getByRole("link")).toHaveCount(2);
    await expect(group(page, PROJECT_NAME).getByText(TITLE_HIT_TITLE)).toBeVisible();
    await expect(group(page, PROJECT_NAME).getByText(OTHER_HIT_TITLE)).toHaveCount(0);

    await expect(group(page, OTHER_PROJECT_NAME).getByRole("link")).toHaveCount(1);
    await expect(group(page, OTHER_PROJECT_NAME).getByText(OTHER_HIT_TITLE)).toBeVisible();
  });

  test("a task stored before priorities existed still renders one", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await arriveWith(page, LEGACY_HIT_WORD);

    const row = results(page).filter({ hasText: LEGACY_HIT_TITLE });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Medium");

    await arriveWith(page, LEGACY_HIT_KEY);
    const byKey = results(page).filter({ hasText: LEGACY_HIT_TITLE });
    await expect(byKey).toHaveCount(1);
    await expect(byKey).toContainText("Medium");
  });

  test("a result opens the task it names", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await arriveWith(page, SEARCH_WORD);

    await results(page).filter({ hasText: BODY_HIT_TITLE }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/tasks/${BODY_HIT_NUMBER}$`));
    await expect(page.getByText(BODY_HIT_TITLE).first()).toBeVisible();
  });

  test("typing a query puts the query in the address", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openSearchPage(page);

    const answered = page.waitForResponse(searchFor(BODY_HIT_KEY));
    await pageInput(page).fill(BODY_HIT_KEY);
    await answered;

    await expect(page).toHaveURL(new RegExp(`/search\\?q=${PROJECT_KEY}-${BODY_HIT_NUMBER}$`));
    await expect(results(page)).toHaveCount(1);
    await expect(results(page).first()).toContainText(BODY_HIT_TITLE);
  });

  test("a settled query fires exactly one request", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openSearchPage(page);

    let count = 0;
    page.on("request", (r) => {
      if (searchRequestFor(SEARCH_WORD)(r.url())) count++;
    });

    const answered = page.waitForResponse(searchFor(SEARCH_WORD));
    await pageInput(page).fill(SEARCH_WORD);
    await answered;
    await page.waitForTimeout(500);

    expect(count).toBe(1);
  });

  test("a one-character query is not searched at all", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openSearchPage(page);

    const answered = page.waitForResponse(searchFor(SEARCH_WORD));
    await pageInput(page).fill(SEARCH_WORD);
    await answered;
    await expect(page).toHaveURL(new RegExp(`/search\\?q=${SEARCH_WORD}$`));
    await expect(results(page).filter({ hasText: TITLE_HIT_TITLE })).toHaveCount(1);

    let requested = false;
    page.on("request", (r) => {
      if (searchRequestFor("z")(r.url())) requested = true;
    });

    await pageInput(page).fill("z");
    await page.waitForTimeout(1_000);

    const witnessed = page.waitForResponse(searchFor(LEGACY_HIT_WORD));
    await pageInput(page).fill(LEGACY_HIT_WORD);
    await witnessed;

    expect(requested).toBe(false);
    await expect(page).toHaveURL(new RegExp(`/search\\?q=${LEGACY_HIT_WORD}$`));
  });

  test("a word nothing carries says so", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await arriveWith(page, ABSENT_WORD);

    await expect(page.getByText("No tasks found")).toBeVisible();
    await expect(results(page)).toHaveCount(0);
  });

  test("the member's results stop at the board they hold a grant on", async ({ page }) => {
    await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
    await arriveWith(page, SEARCH_WORD);

    await expect(page.getByRole("heading", { name: new RegExp(PROJECT_NAME) })).toBeVisible();
    await expect(results(page).filter({ hasText: TITLE_HIT_TITLE })).toHaveCount(1);

    await expect(
      page.getByRole("heading", { name: new RegExp(OTHER_PROJECT_NAME) })
    ).toBeHidden();
    await expect(results(page).filter({ hasText: OTHER_HIT_TITLE })).toHaveCount(0);
  });
});
