import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { GITLAB_STUB_URL } from "../playwright.config";
import {
  GITLAB_PROJECT_KEY,
  GITLAB_REPO,
  GITLAB_TASK_KEY,
  GITLAB_TASK_NUMBER,
  GITLAB_TASK_TITLE,
  GITLAB_TOKEN,
  seed,
  seedGitlabProject,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-695. Everything a GitLab-hosted board shows about its repository, against e2e/gitlab-stub.mjs:
 * the task's branches and commits, the half-loaded state when one of those calls fails, and the
 * merge-request sync run from the settings button.
 */

const TASK_PAGE = `/projects/${GITLAB_PROJECT_KEY}/tasks/${GITLAB_TASK_NUMBER}`;
const WEB = `${GITLAB_STUB_URL}/${GITLAB_REPO}`;

const BRANCH = {
  name: `${GITLAB_TASK_KEY}/mirror-the-fix`,
  web_url: `${WEB}/-/tree/${GITLAB_TASK_KEY}/mirror-the-fix`,
  commit: { committed_date: "2026-08-01T10:00:00Z" },
};
const OTHER_BRANCH = {
  name: `${GITLAB_PROJECT_KEY}-30/another-task`,
  web_url: `${WEB}/-/tree/${GITLAB_PROJECT_KEY}-30/another-task`,
  commit: { committed_date: "2026-08-01T10:00:00Z" },
};
const COMMIT = {
  id: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  short_id: "a1b2c3d4",
  title: `${GITLAB_TASK_KEY} mirror the fix`,
  author_name: "Ada Lovelace",
  created_at: "2026-08-01T10:00:00Z",
};
const UNRELATED_COMMIT = {
  id: "ffffeeeeddddccccbbbbaaaa9999888877776666",
  short_id: "ffffeeee",
  title: "chore: bump dependencies",
  author_name: "Grace Hopper",
  created_at: "2026-08-01T10:00:00Z",
};

async function stub(request: APIRequestContext, fixture: Record<string, unknown>) {
  const response = await request.post(`${GITLAB_STUB_URL}/control`, { data: fixture });
  expect(response.status()).toBe(200);
}

async function asked(request: APIRequestContext) {
  const response = await request.get(`${GITLAB_STUB_URL}/asked`);
  return (await response.json()) as { path: string; search: string | null; token: string | null }[];
}

async function openTask(page: Page) {
  const activity = page.waitForResponse((r) => r.url().endsWith("/gitlab-activity"));
  await page.goto(TASK_PAGE);
  const response = await activity;
  await expect(page.getByRole("textbox", { name: "Task title" })).toHaveValue(GITLAB_TASK_TITLE);
  return response;
}

const section = (page: Page) =>
  page
    .locator("div")
    .filter({ has: page.getByRole("heading", { name: "GitLab activity", exact: true }) })
    .last();

test.beforeEach(async ({ request }) => {
  await seed();
  await seedGitlabProject(GITLAB_STUB_URL);
  await request.post(`${GITLAB_STUB_URL}/reset`);
});

test.describe("GitLab activity on a task", () => {
  test("lists the branches and commits that carry the task's key", async ({ page, request }) => {
    await stub(request, {
      branches: [BRANCH, OTHER_BRANCH, { ...BRANCH, name: "main", web_url: `${WEB}/-/tree/main` }],
      commits: [COMMIT, UNRELATED_COMMIT],
    });
    await signIn(page);

    const response = await openTask(page);
    expect(response.status()).toBe(200);

    const panel = section(page);
    await expect(panel.getByText("Branches (1)")).toBeVisible();
    const branch = panel.getByRole("link", { name: new RegExp(BRANCH.name) });
    await expect(branch).toHaveAttribute("href", BRANCH.web_url);

    await expect(panel.getByText("Commits (1)")).toBeVisible();
    const commit = panel.getByRole("link", { name: new RegExp(COMMIT.short_id) });
    await expect(commit).toContainText(COMMIT.title);
    await expect(commit).toContainText(COMMIT.author_name);
    await expect(commit).toHaveAttribute("href", `${WEB}/-/commit/${COMMIT.id}`);

    await expect(panel.getByText(OTHER_BRANCH.name)).toHaveCount(0);
    await expect(panel.getByText("main", { exact: true })).toHaveCount(0);
    await expect(panel.getByText(UNRELATED_COMMIT.title)).toHaveCount(0);
    await expect(panel.getByText(/Could not load/)).toHaveCount(0);

    // The stored token is sealed; the stub refuses anything but the plaintext, so this is the
    // server's decryption and not a fixture passing through
    const requests = await asked(request);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const r of requests) expect(r.token).toBe(GITLAB_TOKEN);
    expect(requests.find((r) => r.path.endsWith("/search"))?.search).toBe(GITLAB_TASK_KEY);
  });

  test("a failed commit search still shows the branches, and says what is missing", async ({
    page,
    request,
  }) => {
    await stub(request, { branches: [BRANCH], commits: [COMMIT], fail: ["commits"] });
    await signIn(page);

    const response = await openTask(page);
    expect(response.status()).toBe(200);

    const panel = section(page);
    await expect(panel.getByRole("link", { name: new RegExp(BRANCH.name) })).toBeVisible();
    await expect(panel.getByText("Could not load commits")).toBeVisible();
    await expect(panel.getByText(COMMIT.title)).toHaveCount(0);
  });

  test("a failed branch listing still shows the commits, and says what is missing", async ({
    page,
    request,
  }) => {
    await stub(request, { branches: [BRANCH], commits: [COMMIT], fail: ["branches"] });
    await signIn(page);

    const response = await openTask(page);
    expect(response.status()).toBe(200);

    const panel = section(page);
    await expect(panel.getByRole("link", { name: new RegExp(COMMIT.short_id) })).toBeVisible();
    await expect(panel.getByText("Could not load branches")).toBeVisible();
    await expect(panel.getByText(BRANCH.name)).toHaveCount(0);
  });
});

test.describe("the merge-request sync", () => {
  test("links a merge request naming the task's key, from the settings button", async ({
    page,
    request,
  }) => {
    const mergeRequest = {
      iid: 12,
      title: "Mirror the fix",
      state: "opened",
      web_url: `${WEB}/-/merge_requests/12`,
      merged_at: null,
      source_branch: BRANCH.name,
      updated_at: "2026-08-01T10:00:00Z",
    };
    const unrelated = {
      iid: 13,
      title: "chore: bump dependencies",
      state: "opened",
      web_url: `${WEB}/-/merge_requests/13`,
      merged_at: null,
      source_branch: "chore/deps",
      updated_at: "2026-08-01T10:00:00Z",
    };
    await stub(request, { mergeRequests: [mergeRequest, unrelated] });
    await signIn(page);

    // Before the sync: the page is loaded and there is no link yet
    await openTask(page);
    await expect(page.getByRole("link", { name: /#12/ })).toHaveCount(0);

    await page.goto(`/projects/${GITLAB_PROJECT_KEY}/settings?section=integrations`);
    const picker = page.getByRole("button", { name: /Add integration/ });
    const row = page.getByRole("button", { name: /^GitLab/ });
    await expect(picker.or(row).first()).toBeVisible();
    const syncButton = page.getByRole("button", { name: "Sync merge requests now" });
    await expect(async () => {
      if (!(await syncButton.isVisible())) await row.first().click();
      await expect(syncButton).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });

    const synced = page.waitForResponse(
      (r) => r.url().endsWith("/gitlab/sync") && r.request().method() === "POST"
    );
    await syncButton.click();
    const response = await synced;
    expect(response.status(), await response.text()).toBe(200);
    expect(await response.json()).toMatchObject({ prsFound: 1, tasksLinked: 1, prsLinked: 1 });
    await expect(page.getByTestId("toast").last()).toContainText("Synced: 1 MRs linked to 1 tasks");

    await openTask(page);
    const link = page.getByRole("link", { name: /#12/ });
    await expect(link).toContainText(mergeRequest.title);
    await expect(link).toContainText("GitLab");
    await expect(link).toContainText("open");
    await expect(link).toHaveAttribute("href", mergeRequest.web_url);
    await expect(page.getByRole("link", { name: /#13/ })).toHaveCount(0);

    expect((await asked(request)).some((r) => r.path.endsWith("/merge_requests"))).toBe(true);
  });
});
