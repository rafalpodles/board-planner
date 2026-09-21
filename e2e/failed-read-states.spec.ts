import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  DECOY_TASK_TITLE,
  PERSONAL_AGENT_ID,
  PERSONAL_AGENT_NAME,
  PROJECT_ID,
  PROJECT_KEY,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  SIBLING_TASK_TITLE,
  SPARE_COLUMN,
  seed,
  seedAgents,
} from "./seed";
import { ADMIN_AUTH } from "./api";
import { signIn as arriveSignedIn } from "./session";
import { answerNoMailServer } from "./mail-screen";

/**
 * BP-577. Six screens swallowed a failed read into an empty result and then made a positive claim
 * about the data — nothing recorded, nothing finished, no mail server configured, no comments, no
 * agent with that id, no tasks found. A read that never answered supports none of them.
 *
 * Every case waits past the toast before asserting: three of these screens already toasted and
 * were still wrong, because the toast is gone after three seconds and the false sentence is not.
 */

test.beforeEach(seed);

const signIn = arriveSignedIn;

/** Long enough for the toast to have cleared — that is the whole point of the ticket */
const AFTER_THE_TOAST = 3500;

/**
 * Fails the matching request until `stop()` is called. Returns the switch, so the same test can
 * prove the screen recovers when a Retry finds a server that answers.
 */
async function failUntilTold(
  page: Page,
  url: string | RegExp | ((url: URL) => boolean),
  { onlyReads = false } = {}
) {
  let failing = true;
  await page.route(url, async (route) => {
    if (!failing || (onlyReads && route.request().method() !== "GET")) return route.fallback();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "the read gave up" }),
    });
  });
  return () => {
    failing = false;
  };
}

const screens = [
  {
    name: "the instance audit log",
    url: "/settings/audit",
    api: "**/api/admin/audit",
    testId: "instance-audit-error",
    claim: "Nothing recorded yet.",
  },
  {
    name: "the run history",
    url: "/settings/workers/runs",
    api: "**/api/admin/runs",
    testId: "fleet-runs-error",
    claim: "Nothing has finished yet.",
  },
  {
    name: "the agents catalog",
    url: "/agents",
    api: "**/api/agents",
    testId: "agents-catalog-error",
    claim: "You have not created an agent yet.",
  },
] as const;

for (const { name, url, api, testId, claim } of screens) {
  test(`${name} says the read failed rather than making a claim`, async ({ page }) => {
    await signIn(page);
    const stopFailing = await failUntilTold(page, api);
    await page.goto(url);

    await expect(page.getByTestId(testId)).toBeVisible();
    await expect(page.getByText(claim)).toHaveCount(0);

    await page.waitForTimeout(AFTER_THE_TOAST);
    await expect(page.getByTestId(testId)).toBeVisible();
    await expect(page.getByText(claim)).toHaveCount(0);

    // The recovered content, not the absence of the error: every one of these screens clears
    // `failed` synchronously on the click, so asserting the error is gone proves only the click
    stopFailing();
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText(claim)).toBeVisible();
    await expect(page.getByTestId(testId)).toHaveCount(0);
  });

  // The control: the same screen against a server that answers — the claim it is entitled to make
  test(`${name} still reads as empty when the read answers`, async ({ page }) => {
    await signIn(page);
    await page.goto(url);

    await expect(page.getByText(claim)).toBeVisible();
    await expect(page.getByTestId(testId)).toHaveCount(0);
  });
}

/**
 * The unconfigured answer, whatever this run's mail server is. Since BP-465 the suite boots one, so
 * the state these two tests are about is no longer the state the app is in — and it is the *answer*
 * they were ever about, not the environment behind it.
 */
async function answerUnconfigured(page: Page) {
  await answerNoMailServer(page);
}

test("the email settings screen never tells an admin to set SMTP_HOST after a failed read", async ({
  page,
}) => {
  await signIn(page);
  const stopFailing = await failUntilTold(page, "**/api/admin/email");
  await page.goto("/settings/email");

  await expect(page.getByTestId("email-settings-error")).toBeVisible();
  await page.waitForTimeout(AFTER_THE_TOAST);
  await expect(page.getByText("No mail server is configured.")).toHaveCount(0);
  await expect(page.getByText("SMTP_HOST")).toHaveCount(0);

  stopFailing();
  await answerUnconfigured(page);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("No mail server is configured.")).toBeVisible();
  await expect(page.getByTestId("email-settings-error")).toHaveCount(0);
});

// The control for the one above: an instance with no SMTP must still get the instruction
test("the email settings screen still says so when the read answers unconfigured", async ({
  page,
}) => {
  await signIn(page);
  await answerUnconfigured(page);
  await page.goto("/settings/email");

  await expect(page.getByTestId("email-settings-error")).toHaveCount(0);
  await expect(page.getByText("No mail server is configured.")).toBeVisible();
});

test("a search that fails says so rather than reporting no tasks", async ({ page }) => {
  await signIn(page);
  const stopFailing = await failUntilTold(page, /\/api\/search\?q=/);
  await page.goto("/search");

  const box = page.getByRole("textbox", { name: "Search tasks and projects" });
  await expect(box).toBeVisible();
  await box.fill("review");
  // A fill dropped before hydration shows up as the alert below never arriving, not as a pass:
  // `toHaveValue` cannot tell the two apart, so the real anchor is the assertion that follows
  await expect(box).toHaveValue("review");

  await expect(page.getByTestId("search-error")).toBeVisible();
  await expect(page.getByText("No tasks found")).toHaveCount(0);
  await page.waitForTimeout(AFTER_THE_TOAST);
  await expect(page.getByTestId("search-error")).toBeVisible();

  stopFailing();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText(DECOY_TASK_TITLE).first()).toBeVisible();
  await expect(page.getByTestId("search-error")).toHaveCount(0);
});

// The control: a query that matches nothing must still say nothing matched
test("a search that answers with nothing still reports no tasks", async ({ page }) => {
  await signIn(page);
  await page.goto("/search");

  const box = page.getByRole("textbox", { name: "Search tasks and projects" });
  await expect(box).toBeVisible();
  await box.fill("zzzzz-nothing-matches-this");
  await expect(box).toHaveValue("zzzzz-nothing-matches-this");

  await expect(page.getByText("No tasks found")).toBeVisible();
  await expect(page.getByTestId("search-error")).toHaveCount(0);
});

test("a task whose comments cannot be read does not claim it has none", async ({ page }) => {
  await signIn(page);
  const stopFailing = await failUntilTold(page, "**/comments");
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);

  await expect(page.getByTestId("comments-error")).toBeVisible();
  await expect(page.getByText("No comments yet")).toHaveCount(0);
  await page.waitForTimeout(AFTER_THE_TOAST);
  await expect(page.getByTestId("comments-error")).toBeVisible();

  stopFailing();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("No comments yet")).toBeVisible();
  await expect(page.getByTestId("comments-error")).toHaveCount(0);
});

/**
 * BP-582. The panel below tells a failed read from an empty discussion; the **tab above it** draws
 * a number the panel last reported, and a read that failed is no evidence for the one before it.
 * On a task with comments, a failed reload left "Comments 3" beside a panel saying the count is
 * unknown.
 */
test("the tab drops its count when a reload of the comments fails", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);

  const tab = page.getByRole("tab", { name: /^Comments/ });
  await expect(tab).toContainText("0");

  // The read only, not the write: posting is what makes the panel re-read, and the ticket's own
  // repro is a comment that lands while the list cannot be fetched
  let failing = false;
  await page.route(
    (url) => url.pathname.endsWith("/comments"),
    async (route) => {
      if (!failing || route.request().method() !== "GET") return route.fallback();
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    }
  );

  const box = page.getByRole("textbox", { name: "Write a comment, @mention someone…" });
  await expect(box).toBeVisible();
  await box.fill("A remark nobody will be able to count");
  failing = true;
  await page.getByRole("button", { name: "Comment", exact: true }).click();

  await expect(page.getByTestId("comments-error")).toBeVisible();
  // The whole label, not "does not contain 0": forbidding the digit lets any *other* invented
  // number through, and the count this task really has is the one digit the assertion named
  await expect(tab, "no number beside a panel that cannot count").toHaveText("Comments");
});

// The control: a task nobody has commented on still says so
test("a task with no comments still says it has none", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);

  await expect(page.getByText("No comments yet")).toBeVisible();
  await expect(page.getByTestId("comments-error")).toHaveCount(0);
});

test("the agent editor says the catalog could not be read, not that the agent is gone", async ({
  page,
}) => {
  await seedAgents();
  await signIn(page);
  const stopFailing = await failUntilTold(page, "**/api/agents");
  await page.goto(`/agents/${PERSONAL_AGENT_ID}`);

  await expect(page.getByTestId("agent-editor-error")).toBeVisible();
  await expect(page.getByText("No agent with that id.")).toHaveCount(0);
  await page.waitForTimeout(AFTER_THE_TOAST);
  await expect(page.getByTestId("agent-editor-error")).toBeVisible();

  stopFailing();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: PERSONAL_AGENT_NAME })).toBeVisible();
  await expect(page.getByTestId("agent-editor-error")).toHaveCount(0);
});

// The control: an id nobody owns is a different answer, and must still be given
test("the agent editor still says no agent with that id when the read answers", async ({ page }) => {
  await seedAgents();
  await signIn(page);
  await page.goto("/agents/e2e00000000000000000dead");

  await expect(page.getByText("No agent with that id.")).toBeVisible();
  await expect(page.getByTestId("agent-editor-error")).toHaveCount(0);
});

/**
 * BP-700. The two banners that sit above a catalog already on screen: a mutation that lands and a
 * reload after it that does not. Only the read is failed, so the write is real and the refreshed
 * catalog has something the stale one lacks — which is what shows the Retry read again.
 */
const AGENTS_READ = (url: URL) => url.pathname === "/api/agents";

test("the catalog keeps what it has and says a refresh failed, and Retry brings the new agent", async ({
  page,
}) => {
  await seedAgents();
  await signIn(page);
  await page.goto("/agents");
  await expect(page.getByText(PERSONAL_AGENT_NAME)).toBeVisible();

  const stopFailing = await failUntilTold(page, AGENTS_READ, { onlyReads: true });
  const created = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/agents"
  );
  await page.getByRole("button", { name: "New agent" }).click();
  await page.getByLabel("Name").fill("Written while unread");
  await page.getByRole("button", { name: "Create" }).click();
  expect((await created).status()).toBe(201);

  await expect(page.getByTestId("agents-catalog-stale")).toBeVisible();
  await expect(page.getByTestId("agents-catalog-error")).toHaveCount(0);
  await page.waitForTimeout(AFTER_THE_TOAST);
  await expect(page.getByTestId("agents-catalog-stale")).toBeVisible();
  await expect(page.getByText(PERSONAL_AGENT_NAME)).toBeVisible();
  await expect(page.getByText("Written while unread")).toHaveCount(0);

  stopFailing();
  await page.getByTestId("agents-catalog-stale").getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Written while unread")).toBeVisible();
  await expect(page.getByTestId("agents-catalog-stale")).toHaveCount(0);
});

// The control: the same write against a server that answers raises no banner at all
test("the catalog shows a new agent with no banner when the reload answers", async ({ page }) => {
  await seedAgents();
  await signIn(page);
  await page.goto("/agents");
  await expect(page.getByText(PERSONAL_AGENT_NAME)).toBeVisible();

  await page.getByRole("button", { name: "New agent" }).click();
  await page.getByLabel("Name").fill("Written and read back");
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page.getByText("Written and read back")).toBeVisible();
  await expect(page.getByTestId("agents-catalog-stale")).toHaveCount(0);
});

test("the agent editor keeps the agent on screen when a reload fails, and Retry reads the rename", async ({
  page,
}) => {
  await seedAgents();
  await signIn(page);
  await page.goto(`/agents/${PERSONAL_AGENT_ID}`);
  await expect(page.getByRole("heading", { name: PERSONAL_AGENT_NAME })).toBeVisible();

  const stopFailing = await failUntilTold(page, AGENTS_READ, { onlyReads: true });
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByRole("textbox", { name: "Agent name" }).fill("Renamed while unread");
  const renamed = page.waitForResponse(
    (r) => r.request().method() === "PUT" && r.url().endsWith(`/api/agents/${PERSONAL_AGENT_ID}`)
  );
  await page.getByRole("button", { name: "Save name" }).click();
  expect((await renamed).status()).toBe(200);

  await expect(page.getByTestId("agent-editor-stale")).toBeVisible();
  await expect(page.getByTestId("agent-editor-error")).toHaveCount(0);
  await page.waitForTimeout(AFTER_THE_TOAST);
  await expect(page.getByTestId("agent-editor-stale")).toBeVisible();
  await expect(page.getByRole("heading", { name: PERSONAL_AGENT_NAME })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();

  stopFailing();
  await page.getByTestId("agent-editor-stale").getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "Renamed while unread" })).toBeVisible();
  await expect(page.getByTestId("agent-editor-stale")).toHaveCount(0);
});

// The control: a rename whose reload answers shows the new name with no banner
test("the agent editor shows a rename with no banner when the reload answers", async ({ page }) => {
  await seedAgents();
  await signIn(page);
  await page.goto(`/agents/${PERSONAL_AGENT_ID}`);
  await expect(page.getByRole("heading", { name: PERSONAL_AGENT_NAME })).toBeVisible();

  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByRole("textbox", { name: "Agent name" }).fill("Renamed and read back");
  await page.getByRole("button", { name: "Save name" }).click();

  await expect(page.getByRole("heading", { name: "Renamed and read back" })).toBeVisible();
  await expect(page.getByTestId("agent-editor-stale")).toHaveCount(0);
});

/**
 * BP-700. The history is a tab beside the comments, not the page: its failure must stay inside
 * it. A status change made through the API before the page opens gives the task one real row, so
 * what the Retry recovers is that row rather than an empty state a failure could imitate.
 */
const HISTORY_READ = (url: URL) => url.pathname.endsWith(`/tasks/${SIBLING_TASK_ID}/activity`);
const HISTORY_ROW = `E2E Admin changed status from In Progress to ${SPARE_COLUMN.label}`;

async function giveTheTaskHistory(request: APIRequestContext) {
  const response = await request.patch(
    `/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}/status`,
    { headers: ADMIN_AUTH, data: { status: SPARE_COLUMN.id } }
  );
  expect(response.status(), await response.text()).toBe(200);
}

test("a task whose history cannot be read says so inside the tab, and Retry reads it", async ({
  page,
  request,
}) => {
  await giveTheTaskHistory(request);
  await signIn(page);
  const stopFailing = await failUntilTold(page, HISTORY_READ);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);

  const historyTab = page.getByRole("tab", { name: /^History/ });
  await historyTab.click();
  const panel = page.locator("#task-panel-history");
  await expect(panel.getByTestId("history-error")).toBeVisible();
  await expect(panel.getByText("No history yet")).toHaveCount(0);

  await page.waitForTimeout(AFTER_THE_TOAST);
  await expect(panel.getByTestId("history-error")).toBeVisible();
  // A section, not the page: the task and its other tab are still there
  await expect(page.getByRole("textbox", { name: "Task title" })).toHaveValue(SIBLING_TASK_TITLE);
  await page.getByRole("tab", { name: /^Comments/ }).click();
  await expect(page.getByText("No comments yet")).toBeVisible();
  await historyTab.click();

  stopFailing();
  await panel.getByRole("button", { name: "Retry" }).click();
  await expect(panel.getByText(HISTORY_ROW)).toBeVisible();
  await expect(panel.getByTestId("history-error")).toHaveCount(0);
});

// The control: the same task with a read that answers shows its row and no panel
test("a task whose history answers shows it", async ({ page, request }) => {
  await giveTheTaskHistory(request);
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);

  await page.getByRole("tab", { name: /^History/ }).click();
  const panel = page.locator("#task-panel-history");
  await expect(panel.getByText(HISTORY_ROW)).toBeVisible();
  await expect(panel.getByTestId("history-error")).toHaveCount(0);
});

/**
 * The count, as BP-582 pinned it for comments: the first read answers and puts a number on the
 * tab, then a comment makes the history re-read and that read fails. The row stays (it is this
 * task's either way); the number beside the tab does not.
 */
test("the History tab drops its count when a reload of the history fails", async ({
  page,
  request,
}) => {
  await giveTheTaskHistory(request);
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);

  const historyTab = page.getByRole("tab", { name: /^History/ });
  await expect(historyTab).toHaveText(/^History\s*[1-9]\d*$/);

  await failUntilTold(page, HISTORY_READ);
  const box = page.getByRole("textbox", { name: "Write a comment, @mention someone…" });
  await expect(box).toBeVisible();
  await box.fill("A remark the history cannot be re-read after");
  const failedReread = page.waitForResponse(
    (r) => HISTORY_READ(new URL(r.url())) && r.status() === 500
  );
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await failedReread;

  await historyTab.click();
  const panel = page.locator("#task-panel-history");
  await expect(panel.getByTestId("history-error")).toBeVisible();
  await expect(panel.getByText(HISTORY_ROW)).toBeVisible();
  await expect(historyTab, "no number beside a panel that cannot count").toHaveText("History");
});
