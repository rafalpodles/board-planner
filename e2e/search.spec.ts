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

/**
 * BP-386. Two readers, one query: the admin reaches both boards, the member holds a grant on TP
 * only, and SEARCH_WORD matches a task on each. Every leak assertion below is paired with the
 * admin control that sees the same task — a silent list caused by a mis-wired fixture reads
 * exactly like a silent list caused by the filter.
 *
 * Two grant surfaces, not one: task hits are filtered by the endpoint, project hits are filtered
 * out of what /api/projects hands the client. They are driven separately.
 *
 * Give this run its own database. The fixture empties whatever it is pointed at, so a sibling
 * suite on the default one wipes the corpus mid-run and the failure impersonates a search bug:
 *   E2E_PORT=4010 PM_STUB_PORT=4011 E2E_MONGODB_URI=mongodb://localhost:27017/bp386_e2e
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
 * Same problem on a page with no cards to wait for. Waiting on a shell request would not settle
 * it — a response predicate pinned to a path matches the one the previous page already had in
 * flight. AuthGuard renders null until the client has resolved the session, so this input being
 * on screen at all is the guarantee, and it comes from the component rather than from timing.
 */
async function openSearchPage(page: Page, url = "/search") {
  await page.goto(url);
  await expect(page.getByPlaceholder("Search tasks by title, description, or key")).toBeVisible();
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
    // No assertion here that the slash was swallowed: at keydown the layer is unmounted, so there
    // is nothing focused for the default action to type into and an empty box proves nothing.
    // The test below is where preventDefault and the typing-target guard are actually driven.
  });

  test("/ pressed inside a text field types, and does not open the layer", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openSearchPage(page);

    const input = page.getByPlaceholder("Search tasks by title, description, or key");

    // The control, on this page rather than another: with focus outside a text field the shortcut
    // does fire here. Both assertions below hold on a page where nothing is wired up at all.
    await page.getByRole("heading", { name: "Search" }).click();
    await page.keyboard.press("/");
    await expect(layerOf(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(layerOf(page)).toBeHidden();

    // The guard this drives is the one that keeps a slash typed into a task title from hijacking
    // the keystroke. Nothing else in either suite reaches it.
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
    // This message is on screen from the moment the layer opens, so it is a statement about the
    // state, not evidence that the keystroke was handled — the request counter below is that.
    await expect(layerOf(page).getByText("Type at least 2 characters to search")).toBeVisible();
    // The 250ms debounce has to be allowed to fire; a request that never fires cannot be awaited
    await page.waitForTimeout(1_000);

    // Then a witness with an order rather than a duration: the same input one character longer
    // does reach the server, and anything the short query had sent would have landed before it.
    await query(page, SEARCH_WORD);
    await expect(options(page).first()).toBeVisible();
    expect(requested).toBe(false);
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

  test("a description-only hit on the other board is reachable by the admin", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    // The word is in neither title. Without this pair the description arm of the endpoint's $or
    // is never asked to respect a project boundary at all — every leak assertion in this file
    // matches on a title — so pushing the filter into one arm of the $or would stay green.
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

    // The two this reader may see, so the absence below is a filtered list and not an empty one
    await expect(options(page).filter({ hasText: TITLE_HIT_TITLE })).toHaveCount(1);
    await expect(options(page).filter({ hasText: BODY_HIT_TITLE })).toHaveCount(1);

    await expect(options(page).filter({ hasText: OTHER_HIT_TITLE })).toHaveCount(0);
    await expect(layerOf(page).getByText("Other projects")).toBeHidden();
  });

  test("a key lookup does not reach the same number on another board", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    // Both boards have a task number 1. For an admin the project filter is empty, so comparing
    // the populated project key is the only thing keeping the other board's TP-1 out — and the
    // member's test below would blame the grant filter for that failure, never this one.
    await query(page, HELD_TASK_KEY);
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText(HELD_TASK_TITLE);
    await expect(options(page).filter({ hasText: OTHER_HIT_TITLE })).toHaveCount(0);
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

  test("the key the member cannot use does resolve for the admin", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openBoard(page);
    await openLayer(page);

    // Without this, the member's silence above could equally mean SB-1 is unfindable by anyone —
    // a wrong task number, or a key whose case the branch never matches
    await query(page, OTHER_HIT_KEY);
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText(OTHER_HIT_TITLE);
  });

  /**
   * One word, both grant surfaces. Project hits never touch /api/search — they are matched
   * client-side out of what /api/projects handed the shell — so this is the second place a grant
   * has to hold. Both boards are named "… Board" and the other board's task says "other board",
   * which is what lets the negative and its control share a single response: a query that stopped
   * matching for some reason unrelated to grants would take the control down with it.
   */
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
    // The control and the two negatives are the same list, built from the same answer
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText(PROJECT_NAME);
    await expect(options(page).filter({ hasText: OTHER_PROJECT_NAME })).toHaveCount(0);
    await expect(options(page).filter({ hasText: OTHER_HIT_TITLE })).toHaveCount(0);
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

  /**
   * BP-406: submitting this form fires the same request twice — once from handleSubmit and once
   * from the effect watching ?q. Both waits here take the first. If BP-406 is fixed by changing
   * which query is sent rather than by dropping the duplicate, these time out, and the failure
   * will read as a broken search rather than as a changed contract.
   */
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

    // The default is applied at two call sites and the text search only reaches one. Found by key,
    // the same task goes through the other — where a missing default renders an empty badge.
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

    // A second valid submit, awaited, so the silence about "z" is an ordering fact and not a
    // guess about how long a shared machine takes
    const witnessed = page.waitForResponse(searchFor(LEGACY_HIT_WORD));
    await pageInput(page).fill(LEGACY_HIT_WORD);
    await pageInput(page).press("Enter");
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
