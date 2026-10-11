import { test, expect, type Page } from "@playwright/test";
import {
  seed,
  seedAgents,
  seedAssignmentOutsider,
  seedMachine,
  seedMcpConnection,
  seedOwnAiKey,
  makeBoardFresh,
  setBoardReadiness,
  HANDOVER_REPOSITORY,
  OWNER_ID,
  OUTSIDER_FULL_NAME,
  OUTSIDER_USERNAME,
  PROJECT_AGENT_NAME,
  PROJECT_KEY,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-1034. Every step of the setup guide, taken the way a person takes it, with the guide in the
 * sidebar saying so each time: once as a board's owner, who is no instance admin, and once as an
 * instance admin, who has two steps the owner has not.
 */

type Guide = { show: boolean; steps: { id: string; done: boolean }[] };

const card = (page: Page) => page.getByTestId("setup-guide-card");
const count = (page: Page) => page.getByTestId("setup-guide-count");

test.beforeEach(async () => {
  await seed();
  await seedAgents();
  await seedAssignmentOutsider();
  await makeBoardFresh();
});

async function guideOf(page: Page): Promise<Guide> {
  const response = await page.request.get(`/api/projects/${PROJECT_KEY}/setup-guide`);
  expect(response.status()).toBe(200);
  return response.json();
}

const doneIds = (guide: Guide) => guide.steps.filter((s) => s.done).map((s) => s.id);

/** After a step: the server says it is done, and the card in the sidebar caught up without a reload */
async function expectTicked(page: Page, id: string, doneCount: number, total: number) {
  await expect.poll(async () => doneIds(await guideOf(page)), { timeout: 15_000 }).toContain(id);
  if (await card(page).count()) {
    await expect(count(page)).toHaveText(`${doneCount} of ${total} done`, { timeout: 15_000 });
  }
}

const saveChanges = (page: Page) => page.getByRole("button", { name: "Save changes" });

async function saved(page: Page, action: () => Promise<void>, match: (url: URL, method: string) => boolean) {
  const answered = page.waitForResponse((r) => match(new URL(r.url()), r.request().method()));
  await action();
  expect((await answered).ok()).toBe(true);
}

test("an owner who is no instance admin takes all twelve steps", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(card(page)).toBeVisible();
  const before = await guideOf(page);
  expect(before.steps).toHaveLength(12);
  expect(doneIds(before)).toEqual([]);
  await expect(count(page)).toHaveText("0 of 12 done");

  await test.step("tasks: the guide's own link opens the new-task form", async () => {
    await card(page).click();
    await page.getByTestId("setup-guide-next").getByRole("link", { name: "New task" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Title" }).fill("First task");
    await saved(
      page,
      () => dialog.getByRole("button", { name: /^Create( Task)?$/ }).click(),
      (url, method) => method === "POST" && url.pathname.endsWith("/tasks")
    );
    await expectTicked(page, "tasks", 1, 12);
  });

  await test.step("team: somebody is added to the board", async () => {
    await page.goto(`/projects/${PROJECT_KEY}/settings?section=general`);
    await page.getByLabel("Add person").fill(OUTSIDER_USERNAME);
    await page.getByRole("button", { name: OUTSIDER_FULL_NAME }).click();
    await saved(
      page,
      () => saveChanges(page).click(),
      (url, method) => url.pathname.endsWith("/members") && method === "PUT"
    );
    await expectTicked(page, "team", 2, 12);
  });

  await test.step("columns: one is renamed", async () => {
    await page.goto(`/projects/${PROJECT_KEY}/settings?section=board`);
    await page.getByLabel("Column name").first().fill("Backlog");
    await saved(
      page,
      () => saveChanges(page).click(),
      (url, method) => method === "PUT" && /\/api\/projects\/[^/]+(\/columns)?$/.test(url.pathname)
    );
    await expectTicked(page, "columns", 3, 12);
  });

  await test.step("fields: a category is added", async () => {
    await page.goto(`/projects/${PROJECT_KEY}/settings?section=fields`);
    await page.getByRole("button", { name: "+ Add category" }).click();
    await page.getByLabel("Category name").last().fill("support");
    await saved(
      page,
      () => saveChanges(page).click(),
      (url, method) => method !== "GET" && url.pathname.includes("/categories")
    );
    await expectTicked(page, "fields", 4, 12);
  });

  await test.step("sprint: one is made", async () => {
    await page.goto(`/projects/${PROJECT_KEY}/sprints`);
    await page.getByRole("button", { name: /New Sprint|Create your first sprint/ }).first().click();
    await saved(
      page,
      () => page.getByRole("dialog").getByRole("button", { name: "Create" }).click(),
      (url, method) => method === "POST" && url.pathname.endsWith("/sprints")
    );
    await expectTicked(page, "sprint", 5, 12);
  });

  await test.step("repository: it is named", async () => {
    await page.goto(`/projects/${PROJECT_KEY}/settings?section=integrations`);
    await page.getByPlaceholder("https://github.com/owner/repo").fill(HANDOVER_REPOSITORY);
    await saved(
      page,
      () => saveChanges(page).click(),
      (url, method) => method === "PUT" && /\/api\/projects\/[^/]+$/.test(url.pathname)
    );
    await expectTicked(page, "repository", 6, 12);
  });

  await test.step("channel: a Slack channel is added", async () => {
    await page.getByRole("button", { name: "+ Add integration" }).click();
    await page.getByRole("button", { name: /^Team channels/ }).click();
    await page.getByPlaceholder("Channel name...").fill("team-orbit");
    await page.getByPlaceholder(/^https:\/\/hooks\.slack\.com/).fill("https://hooks.slack.com/services/T000/B000/e2e");
    await page.getByRole("button", { name: "Add", exact: true }).first().click();
    await saved(
      page,
      () => saveChanges(page).click(),
      (url, method) => method !== "GET" && url.pathname.includes("/notification")
    );
    await expectTicked(page, "channel", 7, 12);
  });

  await test.step("webhook: an endpoint is added", async () => {
    await page.getByRole("button", { name: "+ Add integration" }).click();
    await page.getByRole("button", { name: /^Webhooks/ }).click();
    await page.getByPlaceholder("https://example.com/webhook").fill("https://example.com/webhook");
    await page
      .getByPlaceholder("https://example.com/webhook")
      .locator("xpath=ancestor::div[.//button[normalize-space()='Add']][1]")
      .getByRole("button", { name: "Add", exact: true })
      .click();
    await saved(
      page,
      () => saveChanges(page).click(),
      (url, method) => method !== "GET" && url.pathname.includes("/webhooks")
    );
    await expectTicked(page, "webhook", 8, 12);
  });

  await test.step("mcp: a client is connected, and the guide sends the reader to the docs for how", async () => {
    await card(page).click();
    await expect(page.getByTestId("setup-guide-next")).toContainText("Connect an MCP client");
    await expect(page.getByTestId("setup-guide-next").getByRole("link", { name: "How to connect" })).toHaveAttribute(
      "href",
      "https://board-planner.com/docs/ai/claude-code-and-mcp/"
    );
    await seedMcpConnection(OWNER_ID);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expectTicked(page, "mcp", 9, 12);
  });

  await test.step("runs: the owner lets workers run tasks", async () => {
    await page.goto(`/projects/${PROJECT_KEY}/settings?section=workers`);
    await page.getByText(/Let workers run tasks/).click();
    await saved(
      page,
      () => saveChanges(page).click(),
      (url, method) => method === "PUT" && /\/api\/projects\/[^/]+$/.test(url.pathname)
    );
    await expectTicked(page, "runs", 10, 12);
  });

  await test.step("machine: a machine of the owner's holds a checkout, and the guide hears of it on coming back", async () => {
    await seedMachine("git@github.com:e2e/handover-board.git", { owner: OWNER_ID });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expectTicked(page, "machine", 11, 12);
  });

  await test.step("handover: an agent is picked on a task", async () => {
    await page.goto(`/projects/${PROJECT_KEY}`);
    await page.getByText("First task").first().click();
    await page.getByRole("combobox", { name: "Agent" }).first().click();
    await page.getByRole("option", { name: new RegExp(PROJECT_AGENT_NAME) }).click();
    await expect.poll(async () => doneIds(await guideOf(page)), { timeout: 15_000 }).toContain("handover");
  });

  await test.step("done: the guide goes away by itself", async () => {
    expect(await guideOf(page)).toMatchObject({ show: false });
    await page.goto(`/projects/${PROJECT_KEY}`);
    await expect(page.getByText("First task").first()).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });
});

test("an instance admin has two steps more, and takes them", async ({ page }) => {
  await setBoardReadiness({ workerEnabled: false });
  await signIn(page, "admin");
  await page.goto(`/projects/${PROJECT_KEY}`);
  const before = await guideOf(page);
  expect(before.steps).toHaveLength(14);
  expect(before.steps.map((s) => s.id)).toEqual(expect.arrayContaining(["pm", "aiKey"]));
  await expect(count(page)).toHaveText("0 of 14 done");

  await test.step("aiKey: the organisation has its own key", async () => {
    await seedOwnAiKey();
    await page.goto(`/projects/${PROJECT_KEY}`);
    await expectTicked(page, "aiKey", 1, 14);
  });

  await test.step("pm: the agent is turned on for the board", async () => {
    await page.goto(`/projects/${PROJECT_KEY}/settings?section=pm`);
    await page.getByText(/Run the PM agent on this project/).click();
    await saved(
      page,
      () => saveChanges(page).click(),
      (url, method) => method === "PUT" && /\/api\/projects\/[^/]+$/.test(url.pathname)
    );
    await expectTicked(page, "pm", 2, 14);
  });
});
