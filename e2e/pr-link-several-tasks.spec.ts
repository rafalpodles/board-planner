import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { GITHUB_STUB_URL } from "../playwright.config";
import { ADMIN_AUTH } from "./api";
import {
  DECOY_TASK_NUMBER,
  DECOY_TASK_TITLE,
  PROJECT_KEY,
  SIBLING_TASK_NUMBER,
  SIBLING_TASK_TITLE,
  seed,
  seedRepository,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-635. A family of tasks fixed in one pull request is listed in its title, and the branch can
 * only carry one of the keys. The matcher stopped at the branch, so PR #391 linked one task of
 * the four its title named, and the other three showed nothing.
 */

const REPO = "https://github.com/example/board";
const FAMILY_BRANCH = `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}/a-family`;
const SIBLING = `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`;
const DECOY = `${PROJECT_KEY}-${DECOY_TASK_NUMBER}`;

function pull(number: number, ref: string, title: string, over: Record<string, unknown> = {}) {
  return {
    number,
    title,
    state: "open",
    html_url: `${REPO}/pull/${number}`,
    merged_at: null,
    head: { ref, sha: `sha${number}` },
    updated_at: "2026-09-01T00:00:00Z",
    ...over,
  };
}

async function github(request: APIRequestContext, pulls: unknown[]) {
  const response = await request.post(`${GITHUB_STUB_URL}/control`, { data: { pulls, checks: {} } });
  expect(response.status()).toBe(200);
}

async function syncFromSettings(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=integrations`);
  const picker = page.getByRole("button", { name: /Add integration/ });
  const row = page.getByRole("button", { name: /^GitHub/ });
  const syncButton = page.getByRole("button", { name: "Sync pull requests now" });
  await expect(picker.or(row).first()).toBeVisible();
  await expect(async () => {
    if ((await row.first().getAttribute("aria-expanded")) !== "true") await row.first().click();
    await expect(syncButton).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });

  const synced = page.waitForResponse((r) => r.url().endsWith("/github/sync") && r.request().method() === "POST");
  await syncButton.click();
  const response = await synced;
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

async function openTheTask(page: Page, taskNumber: number, title: string) {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${taskNumber}`);
  await expect(page.getByLabel("Task title").first()).toHaveValue(title);
}

async function statusOf(request: APIRequestContext, taskNumber: number) {
  const response = await request.get(`/api/projects/${PROJECT_KEY}/tasks/${taskNumber}`, { headers: ADMIN_AUTH });
  expect(response.status()).toBe(200);
  return (await response.json()).status;
}

test.beforeEach(async () => {
  await seed();
  await seedRepository({ repositoryUrl: REPO, githubToken: "e2e-token-passed-through" });
});

test("every task a title names shows the pull request, and a key taken out of the title takes only that task off", async ({
  page,
  request,
}) => {
  await github(request, [
    pull(391, FAMILY_BRANCH, `fix: a family (${SIBLING}, ${DECOY})`),
    pull(392, "chore/no-key", "chore: nothing to do with the board"),
  ]);
  await signIn(page);

  expect(await syncFromSettings(page)).toMatchObject({ prsFound: 1, prsLinked: 1, tasksLinked: 2, prsUnlinked: 0 });
  await expect(page.getByTestId("toast").last()).toContainText("Synced: 1 PRs linked to 2 tasks");

  await openTheTask(page, SIBLING_TASK_NUMBER, SIBLING_TASK_TITLE);
  await expect(page.getByRole("link", { name: /#391/ })).toBeVisible();
  await openTheTask(page, DECOY_TASK_NUMBER, DECOY_TASK_TITLE);
  await expect(page.getByRole("link", { name: /#391/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /#392/ })).toHaveCount(0);

  await github(request, [pull(391, FAMILY_BRANCH, `fix: only one of them now (${SIBLING})`)]);
  expect(await syncFromSettings(page)).toMatchObject({ prsLinked: 1, tasksLinked: 1, prsUnlinked: 1 });

  await openTheTask(page, DECOY_TASK_NUMBER, DECOY_TASK_TITLE);
  await expect(page.getByTestId("pr-state")).toHaveCount(0, { timeout: 1_000 });
  await openTheTask(page, SIBLING_TASK_NUMBER, SIBLING_TASK_TITLE);
  await expect(page.getByRole("link", { name: /#391/ })).toBeVisible();
});

test("a branch's key survives a title that names another task", async ({ page, request }) => {
  await github(request, [pull(391, FAMILY_BRANCH, `fix: retitled onto ${DECOY}`)]);
  await signIn(page);

  expect(await syncFromSettings(page)).toMatchObject({ prsFound: 1, prsLinked: 1, tasksLinked: 2 });

  await openTheTask(page, SIBLING_TASK_NUMBER, SIBLING_TASK_TITLE);
  await expect(page.getByRole("link", { name: /#391/ })).toBeVisible();
});

test("a merged pull request moves a task in review that only its title names", async ({ page, request }) => {
  expect(await statusOf(request, DECOY_TASK_NUMBER)).toBe("in_review");
  await github(request, [
    pull(391, FAMILY_BRANCH, `fix: a family (${SIBLING}, ${DECOY})`, {
      state: "closed",
      merged_at: "2026-09-02T00:00:00Z",
    }),
  ]);
  await signIn(page);

  expect(await syncFromSettings(page)).toMatchObject({ prsLinked: 1, tasksLinked: 2, autoTransitioned: 1 });

  expect(await statusOf(request, DECOY_TASK_NUMBER)).toBe("ready_to_test");
});
