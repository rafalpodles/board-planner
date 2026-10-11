import { test, expect, type Page } from "@playwright/test";
import {
  seed,
  seedMachine,
  setBoardReadiness,
  removeNonOwnerGrants,
  OWNER_ID,
  PROJECT_KEY,
  HANDOVER_REPOSITORY,
  SIBLING_TASK_TITLE,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-1034. The board's owner is told what is left to set up, each step derived from data that
 * already exists, and a member is told nothing: who holds a role on a board is not theirs to see.
 */

test.beforeEach(async () => {
  await seed();
  await setBoardReadiness({ workerEnabled: false });
});

const card = (page: Page) => page.getByTestId("board-ready");
const step = (page: Page, id: string) => card(page).locator(`[data-step="${id}"]`);

async function openBoard(page: Page, who: "admin" | "member" | "owner") {
  await signIn(page, who);
  const read = page.waitForResponse((res) => res.request().method() === "GET" && res.url().endsWith("/ready"));
  await page.goto(`/projects/${PROJECT_KEY}`);
  const response = await read;
  expect(response.status()).toBe(200);
  return response.json();
}

test("the owner sees what is done and where to do the rest", async ({ page }) => {
  await openBoard(page, "owner");

  await expect(card(page)).toBeVisible();
  await expect(page.getByTestId("board-ready-count")).toHaveText("3 of 6");
  for (const id of ["board", "tasks", "team"]) await expect(step(page, id)).toHaveAttribute("data-done", "true");
  for (const id of ["repository", "runs", "machine"]) await expect(step(page, id)).toHaveAttribute("data-done", "false");

  await expect(step(page, "repository").getByRole("link")).toHaveAttribute("href", /\/settings\?section=integrations$/);
  await expect(step(page, "runs").getByRole("link")).toHaveAttribute("href", /\/settings\?section=workers$/);
  await expect(step(page, "machine").getByRole("link")).toHaveAttribute("href", /\/docs\/ai\/execution-workers\//);
});

test("a board nobody was invited to asks for it", async ({ page }) => {
  await removeNonOwnerGrants();
  await openBoard(page, "owner");

  await expect(step(page, "team")).toHaveAttribute("data-done", "false");
  await expect(step(page, "team").getByRole("link")).toHaveAttribute("href", /\/settings\?section=general$/);
  await expect(page.getByTestId("board-ready-count")).toHaveText("2 of 6");
});

test("a member is shown nothing and the answer carries no steps", async ({ page }) => {
  const body = await openBoard(page, "member");

  expect(body).toEqual({ show: false, steps: [] });
  await expect(page.getByTestId("board-ready")).toHaveCount(0);
});

test("an instance admin lock is its own line, and only an instance admin is sent to lift it", async ({ page }) => {
  await setBoardReadiness({ repositoryUrl: HANDOVER_REPOSITORY, workerEnabled: true, lockedByInstance: true });

  await openBoard(page, "owner");
  await expect(step(page, "runs")).toHaveAttribute("data-done", "false");
  await expect(step(page, "runs")).toContainText("An instance admin has locked agent runs off for this board.");
  await expect(step(page, "runs").getByRole("link")).toHaveCount(0);

  const admin = await page.context().browser()!.newContext();
  const adminPage = await admin.newPage();
  await openBoard(adminPage, "admin");
  await expect(step(adminPage, "runs").getByRole("link")).toHaveAttribute("href", /\/settings\?section=workers$/);
  await admin.close();
});

test("the list goes away by itself once everything is in place", async ({ page }) => {
  await setBoardReadiness({ repositoryUrl: HANDOVER_REPOSITORY, workerEnabled: true });
  await seedMachine("git@github.com:e2e/handover-board.git", { owner: OWNER_ID });

  const body = await openBoard(page, "owner");

  expect(body.steps.every((s: { done: boolean }) => s.done)).toBe(true);
  expect(body.show).toBe(false);
  await expect(page.getByText(SIBLING_TASK_TITLE).first()).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});

test("hiding it is per person: it stays hidden for the owner and shows for the admin", async ({ page }) => {
  await openBoard(page, "owner");
  await expect(card(page)).toBeVisible();

  const saved = page.waitForResponse((res) => res.request().method() === "PUT" && res.url().endsWith("/ready"));
  await page.getByTestId("board-ready-hide").click();
  expect((await saved).status()).toBe(200);
  await expect(card(page)).toHaveCount(0);

  const reloaded = page.waitForResponse((res) => res.request().method() === "GET" && res.url().endsWith("/ready"));
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
