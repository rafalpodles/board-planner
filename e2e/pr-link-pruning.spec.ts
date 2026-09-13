import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { GITHUB_STUB_URL } from "../playwright.config";
import { ADMIN_AUTH } from "./api";
import {
  PROJECT_KEY,
  SIBLING_TASK_NUMBER,
  SIBLING_TASK_TITLE,
  DECOY_TASK_NUMBER,
  seed,
  seedRepository,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-617 and BP-610. A repository fetch is a window, not a history — GitHub answers with its open
 * pull requests plus the thirty most recently updated closed ones — and the sync used to treat
 * "absent from this round" as "no longer this task's". So a task holding two pull requests lost
 * the older one as soon as the newer one appeared, on an ordinary project, with nobody doing
 * anything unusual.
 *
 * The unit tests pin the decision and `pr-link-replacement.spec.ts` pins what the pipeline does to
 * a document. What is left, and what only a real sync against a real database can show, is the
 * round trip: the query that finds the tasks a round contradicts, and the badges a person reads.
 */

const REPO = "https://github.com/example/board";
const SEEDED_TOKEN = "e2e-token-passed-through";

function pull(number: number, ref: string, over: Record<string, unknown> = {}) {
  return {
    number,
    title: `Pull request ${number}`,
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

async function syncNow(request: APIRequestContext) {
  const response = await request.post(`/api/projects/${PROJECT_KEY}/github/sync`, {
    headers: ADMIN_AUTH,
    data: {},
  });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

/** The links on one task, as the API hands them to the screen. */
async function linksOn(request: APIRequestContext, taskNumber: number): Promise<number[]> {
  const response = await request.get(`/api/projects/${PROJECT_KEY}/tasks/${taskNumber}`, {
    headers: ADMIN_AUTH,
  });
  expect(response.status()).toBe(200);
  const task = await response.json();
  return (task.linkedPRs ?? []).map((link: { number: number }) => link.number).sort(
    (a: number, b: number) => a - b
  );
}

async function openTheTask(page: Page, taskNumber: number, title: string) {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${taskNumber}`);
  await expect(page.getByLabel("Task title").first()).toHaveValue(title);
}

test.beforeEach(async () => {
  await seed();
  await seedRepository({ repositoryUrl: REPO, githubToken: SEEDED_TOKEN });
});

test("a pull request that has left the window is kept when a newer one arrives", async ({
  page,
  request,
}) => {
  const branch = `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}/first`;
  await github(request, [pull(9, branch)]);
  await syncNow(request);
  expect(await linksOn(request, SIBLING_TASK_NUMBER)).toEqual([9]);

  // The window has moved on: 9 is past the thirty most recently updated closed ones, and only the
  // newer pull request comes back. Nothing says 9 stopped being this task's.
  await github(request, [pull(412, `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}/second`)]);
  const result = await syncNow(request);

  expect(await linksOn(request, SIBLING_TASK_NUMBER)).toEqual([9, 412]);
  expect(result.prsUnlinked).toBe(0);

  await signIn(page);
  await openTheTask(page, SIBLING_TASK_NUMBER, SIBLING_TASK_TITLE);
  // Both badges, which is what the defect took away: the older link was deleted by a sync that
  // had only ever been told about the newer one.
  await expect(page.getByRole("link", { name: /#412/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /#9\b/ })).toBeVisible();
});

test("a pull request the round gives to another task leaves the first one", async ({
  page,
  request,
}) => {
  await github(request, [pull(41, `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}/keep`)]);
  await syncNow(request);
  expect(await linksOn(request, SIBLING_TASK_NUMBER)).toEqual([41]);

  // Retitled onto another task, on a branch that never carried a key: the sibling is not in this
  // round's grouping at all, so nothing visits it unless the sync goes looking.
  await github(request, [pull(41, "feat/no-key-at-all", { title: `${PROJECT_KEY}-${DECOY_TASK_NUMBER} moved` })]);
  const result = await syncNow(request);

  expect(await linksOn(request, SIBLING_TASK_NUMBER)).toEqual([]);
  expect(await linksOn(request, DECOY_TASK_NUMBER)).toEqual([41]);
  expect(result.prsUnlinked).toBe(1);

  await signIn(page);
  await openTheTask(page, SIBLING_TASK_NUMBER, SIBLING_TASK_TITLE);
  // The title above is the positive this negative needs: the panel has loaded, and the badge the
  // sync removed is not on it.
  await expect(page.getByTestId("pr-state")).toHaveCount(0, { timeout: 1_000 });
});
