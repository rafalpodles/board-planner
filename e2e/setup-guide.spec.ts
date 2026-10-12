import { test, expect, type Page } from "@playwright/test";
import { seed, setBoardReadiness, removeAllTasks, removeNonOwnerGrants, PROJECT_KEY, HANDOVER_REPOSITORY } from "./seed";
import { signIn } from "./session";

/**
 * BP-1034. The sidebar tells a board's owner what is left to set up, each step derived from data
 * that already exists, and tells a member nothing: who holds a role on a board is not theirs to see.
 */

test.beforeEach(async () => {
  await seed();
  await setBoardReadiness({ workerEnabled: false });
});

type Guide = { show: boolean; steps: { id: string; group: string; done: boolean; locked: boolean }[] };

const card = (page: Page) => page.getByTestId("setup-guide-card");
const panel = (page: Page) => page.getByTestId("setup-guide-panel");
const step = (page: Page, id: string) => panel(page).locator(`[data-step="${id}"]`);

async function openBoard(page: Page, who: "admin" | "member" | "owner"): Promise<Guide> {
  await signIn(page, who);
  const read = page.waitForResponse((res) => res.request().method() === "GET" && res.url().endsWith("/setup-guide"));
  await page.goto(`/projects/${PROJECT_KEY}`);
  const response = await read;
  expect(response.status()).toBe(200);
  return response.json();
}

const countOf = (guide: Guide) => `${guide.steps.filter((s) => s.done).length} of ${guide.steps.length} done`;

test("an owner sees the guide in the sidebar, its count matching what the server derived", async ({ page }) => {
  const guide = await openBoard(page, "owner");

  expect(guide.show).toBe(true);
  expect(guide.steps.map((s) => s.id)).not.toEqual(expect.arrayContaining(["pm"]));
  expect(guide.steps.some((s) => s.id === "aiKey" || s.id === "sso" || s.id === "plan")).toBe(false);
  await expect(page.getByTestId("setup-guide-count")).toHaveText(countOf(guide));
  await expect(card(page)).toContainText("Next");
});

test("opening it swaps the project list for the guide, and Back brings the list back", async ({ page }) => {
  await openBoard(page, "owner");

  await card(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId("setup-guide-next")).toBeVisible();
  // No AI group: the PM agent is an instance admin's to switch on
  await expect(page.getByTestId("setup-guide-group")).toHaveCount(3);

  await page.getByTestId("setup-guide-close").click();
  await expect(panel(page)).toHaveCount(0);
  await expect(card(page)).toBeVisible();
});

test("steps expand to say why and offer their action", async ({ page }) => {
  await openBoard(page, "owner");
  await card(page).click();

  await panel(page).locator('[data-group="connections"]').getByRole("button", { name: /Connections/ }).click();
  await step(page, "repository").getByRole("button").click();

  await expect(step(page, "repository")).toContainText("Pull requests show up on their tasks");
  await expect(step(page, "repository").getByRole("link", { name: "Settings › Integrations" })).toHaveAttribute(
    "href",
    /\/settings\?section=integrations$/
  );
});

test("an instance admin has the steps only an instance admin can take, an owner has not", async ({ page }) => {
  const guide = await openBoard(page, "admin");

  expect(guide.steps.map((s) => s.id)).toEqual(expect.arrayContaining(["pm", "aiKey"]));
  expect(guide.steps.some((s) => s.id === "sso" || s.id === "plan")).toBe(false);
  await expect(page.getByTestId("setup-guide-count")).toHaveText(countOf(guide));
});

test("a member is shown nothing and the answer carries no steps", async ({ page }) => {
  const guide = await openBoard(page, "member");

  expect(guide).toEqual({ show: false, steps: [] });
  await expect(card(page)).toHaveCount(0);
});

test("a board nobody was invited to leaves the team step open", async ({ page }) => {
  await removeNonOwnerGrants();
  const guide = await openBoard(page, "owner");

  expect(guide.steps.find((s) => s.id === "team")?.done).toBe(false);
});

test("a step taken on the page the guide is looking at ticks without a reload", async ({ page }) => {
  const before = await openBoard(page, "owner");
  await expect(page.getByTestId("setup-guide-count")).toHaveText(countOf(before));

  await page.goto(`/projects/${PROJECT_KEY}/settings?section=integrations`);
  const repository = page.getByPlaceholder("https://github.com/owner/repo");
  await expect(repository).toBeVisible();
  await repository.fill(HANDOVER_REPOSITORY);
  const saved = page.waitForResponse((res) => res.request().method() === "PUT" && /\/api\/projects\/[^/]+$/.test(res.url()));
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await saved).status()).toBe(200);

  const done = before.steps.filter((s) => s.done).length + 1;
  await expect(page.getByTestId("setup-guide-count")).toHaveText(`${done} of ${before.steps.length} done`);
});

test("an instance admin lock is its own line, and only an instance admin is sent to lift it", async ({ page }) => {
  await setBoardReadiness({ repositoryUrl: HANDOVER_REPOSITORY, workerEnabled: true, lockedByInstance: true });

  await openBoard(page, "owner");
  await card(page).click();
  await panel(page).locator('[data-group="agents"]').getByRole("button", { name: /Agents/ }).click();
  await step(page, "runs").getByRole("button").click();
  await expect(step(page, "runs")).toContainText("An instance admin has locked agent runs off for this board.");
  await expect(step(page, "runs").getByRole("link")).toHaveCount(0);

  const admin = await page.context().browser()!.newContext();
  const adminPage = await admin.newPage();
  await openBoard(adminPage, "admin");
  await card(adminPage).click();
  await panel(adminPage).locator('[data-group="agents"]').getByRole("button", { name: /Agents/ }).click();
  await step(adminPage, "runs").getByRole("button").click();
  await expect(step(adminPage, "runs").getByRole("link")).toHaveAttribute("href", /\/settings\?section=workers$/);
  await admin.close();
});

test("the first step opens the new-task form on the board it is already on", async ({ page }) => {
  await removeAllTasks();
  await openBoard(page, "owner");
  await card(page).click();
  await expect(page.getByTestId("setup-guide-next")).toContainText("Add your first tasks");

  await page.getByTestId("setup-guide-next").getByRole("link", { name: "New task" }).click();

  await expect(page.getByRole("heading", { name: "New Task" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
});

test("hiding it is per person: it stays hidden for the owner and shows for the admin", async ({ page }) => {
  await openBoard(page, "owner");
  await card(page).click();

  const saved = page.waitForResponse((res) => res.request().method() === "PUT" && res.url().endsWith("/setup-guide"));
  await page.getByTestId("setup-guide-hide").click();
  expect((await saved).status()).toBe(200);
  await expect(card(page)).toHaveCount(0);

  const reloaded = page.waitForResponse((res) => res.request().method() === "GET" && res.url().endsWith("/setup-guide"));
  await page.reload();
  expect(await (await reloaded).json()).toMatchObject({ show: false });
  await expect(card(page)).toHaveCount(0);

  const admin = await page.context().browser()!.newContext();
  const adminPage = await admin.newPage();
  const body = await openBoard(adminPage, "admin");
  expect(body.show).toBe(true);
  await expect(card(adminPage)).toBeVisible();
  await admin.close();
});
