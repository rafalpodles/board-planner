import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  ABSENT_WORD,
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  BODY_HIT_NUMBER,
  BODY_HIT_TITLE,
  HELD_TASK_TITLE,
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

/**
 * BP-386. Two readers, one query: the admin reaches both boards, the member holds a grant on TP
 * only, and SEARCH_WORD matches a task on each. Every leak assertion below is paired with the
 * admin control that sees the same task — a silent list caused by a mis-wired fixture reads
 * exactly like a silent list caused by the filter.
 *
 * Two grant surfaces, not one: task hits are filtered by the endpoint, project hits are filtered
 * out of what /api/projects hands the client. They are driven separately.
 *
 * The task's "/search page filters" names something that does not exist — that page has a query
 * box and a list grouped by project, and no filter controls of any kind. The clause is covered
 * only in the sense that the two things which do narrow that list, the grant and the query, are
 * both driven. Nothing was written for the clause itself.
 */

const TITLE_HIT_KEY = `${PROJECT_KEY}-${TITLE_HIT_NUMBER}`;
const BODY_HIT_KEY = `${PROJECT_KEY}-${BODY_HIT_NUMBER}`;

/**
 * A 500 is a response too, and both consumers swallow a failed search into an empty list — so a
 * predicate matching on the URL alone lets "the search is broken" pass as "nothing matched".
 * Pinning the query as well keeps a stale answer from satisfying the next question.
 */
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

async function signIn(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);
}

const layerOf = (page: Page) => page.getByRole("dialog", { name: "Search" });
const options = (page: Page) => layerOf(page).getByRole("option");
const layerInput = (page: Page) => layerOf(page).getByLabel("Search tasks and projects");

/**
 * The ⌘K listener is registered in a client effect, so the shortcut does nothing against a page
 * that has merely been painted. The board's cards arrive from a client fetch, which is what says
 * React is running here — five tests failed on that race before this wait existed.
 */
async function openBoard(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByText(HELD_TASK_TITLE).first()).toBeVisible();
}

/**
 * Same problem on a page with no cards to wait for: /api/projects is fetched by the shell's own
 * client hook, so its answer is the signal that the root is hydrated and the form is wired up.
 */
async function openSearchPage(page: Page, url = "/search") {
  const shellReady = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/projects" && r.status() === 200
  );
  await page.goto(url);
  await shellReady;
}

async function openLayer(page: Page) {
  // Hovering an option moves the cursor, and Playwright leaves the pointer wherever the last
  // click put it — which is inside the dialog's box at this viewport
  await page.mouse.move(0, 0);
  await page.keyboard.press("ControlOrMeta+k");
  const layer = layerOf(page);
  await expect(layer).toBeVisible();
  return layer;
}

/** Results render off whatever the hook is already holding, so every query waits for its answer */
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
    // Nothing typed yet: the layer says what it wants rather than showing an empty list
    await expect(layerOf(page).getByText("Type at least 2 characters to search")).toBeVisible();

    await page.keyboard.press("ControlOrMeta+k");
    await expect(layerOf(page)).toBeHidden();

    await openLayer(page);
    // Two independent handlers close on Escape — the input's own onKeyDown and useFocusTrap — so
    // what this proves is that one of them is live, never which. Deleting either leaves it green.
    await page.keyboard.press("Escape");
    await expect(layerOf(page)).toBeHidden();

    await page.keyboard.press("/");
    await expect(layerOf(page)).toBeVisible();
    // The slash opened the layer instead of being typed into it
    await expect(layerInput(page)).toHaveValue("");
  });

  test("/ pressed inside a text field types, and does not open the layer", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openSearchPage(page);

    // The guard this drives is the one that keeps a slash typed into a task title from hijacking
    // the keystroke. Nothing else in either suite reaches it.
    const input = page.getByPlaceholder("Search tasks by title, description, or key");
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
    // Long enough for the 250ms debounce to have fired if the floor were not enforced
    await page.waitForTimeout(1_000);
    expect(requested).toBe(false);

    // The control: the same input, one character longer, does reach the server
    await query(page, SEARCH_WORD);
    await expect(options(page).first()).toBeVisible();
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

  test("a query made of regex metacharacters is matched literally", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    // Unescaped this is a character class and matches every title holding a "v" or a "2"
    await query(page, META_QUERY);
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText(META_HIT_TITLE);

    // And the other polarity: unescaped this matches the whole board
    await query(page, META_WILDCARD);
    await expect(layerOf(page).getByText("No matches")).toBeVisible();
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

    // Enter is swallowed while the list is empty, and the response lands before React commits it
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
  });

  test("a project the admin may see is a hit, and opens", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    // Project hits never touch /api/search — they are matched client-side out of what
    // /api/projects handed the shell, which is the second place a grant has to hold
    await query(page, "Second");
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText(OTHER_PROJECT_NAME);

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/projects/${OTHER_PROJECT_KEY}$`));
  });

  test("and is not a hit for the member, who cannot see that project", async ({ page }) => {
    await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    // The control that this reader's project list is not simply empty
    await query(page, PROJECT_NAME.slice(0, 7));
    await expect(options(page).filter({ hasText: PROJECT_NAME })).toHaveCount(1);

    await query(page, "Second");
    await expect(layerOf(page).getByText("No matches")).toBeVisible();
  });
});

test.describe("the /search page", () => {
  const pageInput = (page: Page) =>
    page.getByPlaceholder("Search tasks by title, description, or key");

  /** The rows under one project's heading, rather than every link on the page */
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

    // Scoped to the group, not the page: two headings and two page-wide counts would still pass
    // with every hit filed under the wrong board
    await expect(group(page, PROJECT_NAME).getByRole("link")).toHaveCount(2);
    await expect(group(page, PROJECT_NAME).getByText(TITLE_HIT_TITLE)).toBeVisible();
    await expect(group(page, PROJECT_NAME).getByText(OTHER_HIT_TITLE)).toHaveCount(0);

    await expect(group(page, OTHER_PROJECT_NAME).getByRole("link")).toHaveCount(1);
    await expect(group(page, OTHER_PROJECT_NAME).getByText(OTHER_HIT_TITLE)).toBeVisible();
  });

  test("a task stored before priorities existed still renders one", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await arriveWith(page, LEGACY_HIT_WORD);

    // Nothing wrote a priority on this task; the endpoint applies the default on the way out
    const row = results(page).filter({ hasText: LEGACY_HIT_TITLE });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Medium");
  });

  test("a result opens the task it names", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await arriveWith(page, SEARCH_WORD);

    await results(page).filter({ hasText: BODY_HIT_TITLE }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/tasks/${BODY_HIT_NUMBER}$`));
    await expect(page.getByText(BODY_HIT_TITLE).first()).toBeVisible();
  });

  test("typing a query and submitting it puts the query in the address", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openSearchPage(page);

    const answered = page.waitForResponse(searchFor(BODY_HIT_KEY));
    await pageInput(page).fill(BODY_HIT_KEY);
    await pageInput(page).press("Enter");
    await answered;

    await expect(page).toHaveURL(new RegExp(`/search\\?q=${PROJECT_KEY}-${BODY_HIT_NUMBER}$`));
    await expect(results(page)).toHaveCount(1);
    await expect(results(page).first()).toContainText(BODY_HIT_TITLE);
  });

  test("a one-character query is not submitted at all", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openSearchPage(page);

    // The control first: this form does submit, so the silence below is the floor and not a page
    // that never woke up
    const answered = page.waitForResponse(searchFor(SEARCH_WORD));
    await pageInput(page).fill(SEARCH_WORD);
    await pageInput(page).press("Enter");
    await answered;
    await expect(page).toHaveURL(new RegExp(`/search\\?q=${SEARCH_WORD}$`));
    await expect(results(page).filter({ hasText: TITLE_HIT_TITLE })).toHaveCount(1);

    let requested = false;
    page.on("request", (r) => {
      if (searchRequestFor("z")(r.url())) requested = true;
    });

    await pageInput(page).fill("z");
    await pageInput(page).press("Enter");
    await page.waitForTimeout(1_000);

    expect(requested).toBe(false);
    // The address still names the query that was allowed through
    await expect(page).toHaveURL(new RegExp(`/search\\?q=${SEARCH_WORD}$`));
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
