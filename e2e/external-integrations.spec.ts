import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { WEBHOOK_RECEIVER_URL } from "../playwright.config";
import { ADMIN_AUTH } from "./api";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  LINKED_MR_NUMBER,
  LINKED_MR_TITLE,
  LINKED_PR_NUMBER,
  LINKED_PR_TITLE,
  PROJECT_KEY,
  SIBLING_TASK_NUMBER,
  seed,
  seedLinkedPRs,
  seedRepository,
  seedWebhook,
} from "./seed";
import { signIn as arriveSignedIn } from "./session";

const SETTINGS = `/projects/${PROJECT_KEY}/settings`;

interface Delivery {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

const SETTLE_MS = 2_000;

async function deliveries(request: APIRequestContext): Promise<Delivery[]> {
  const response = await request.get(`${WEBHOOK_RECEIVER_URL}/deliveries`);
  expect(response.status()).toBe(200);
  return response.json();
}

const signIn = arriveSignedIn;

test.beforeEach(seed);

test.describe("webhook delivery", () => {
  test.beforeEach(async ({ request }) => {
    await request.post(`${WEBHOOK_RECEIVER_URL}/reset`);
  });

  test("a board event is never delivered to an http endpoint", async ({ request }) => {
    const direct = await request.post(`${WEBHOOK_RECEIVER_URL}/control`, {
      headers: { "Content-Type": "application/json" },
      data: { probe: true },
    });
    expect(direct.status()).toBe(200);
    expect(await deliveries(request)).toHaveLength(1);

    await seedWebhook(`${WEBHOOK_RECEIVER_URL}/hook`);

    const created = await request.post(`/api/projects/${PROJECT_KEY}/tasks`, {
      headers: ADMIN_AUTH,
      data: { title: "An event with a webhook configured", status: "todo" },
    });
    expect(created.status(), await created.text()).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    expect((await deliveries(request)).filter((d) => d.url === "/hook")).toHaveLength(0);

    await request.post(`${WEBHOOK_RECEIVER_URL}/control`, {
      headers: { "Content-Type": "application/json" },
      data: { probe: "again" },
    });
    expect((await deliveries(request)).filter((d) => d.url === "/control")).toHaveLength(2);
  });

});

test.describe("repository sync", () => {
  test("a project that names no repository is told so rather than reaching for one", async ({
    request,
  }) => {
    const response = await request.post(`/api/projects/${PROJECT_KEY}/github/sync`, {
      headers: ADMIN_AUTH,
      data: {},
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toBe(
      "A repository URL and a GitHub token must be configured in project settings"
    );
  });

  test("a GitLab repository is not synced as a GitHub one", async ({ request }) => {
    await seedRepository({
      repositoryUrl: "https://gitlab.com/example/board",
      githubToken: "not-read-before-the-refusal",
    });

    const response = await request.post(`/api/projects/${PROJECT_KEY}/github/sync`, {
      headers: ADMIN_AUTH,
      data: {},
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toContain("is not a GitHub repository");
  });

  test("a GitHub repository is not synced as a GitLab one", async ({ request }) => {
    await seedRepository({
      repositoryUrl: "https://github.com/example/board",
      gitlabToken: "not-read-before-the-refusal",
    });

    const response = await request.post(`/api/projects/${PROJECT_KEY}/gitlab/sync`, {
      headers: ADMIN_AUTH,
      data: {},
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toContain("is not a GitLab repository");
  });

  test("an unauthenticated sync is refused", async ({ request }) => {
    const response = await request.post(`/api/projects/${PROJECT_KEY}/github/sync`, {
      headers: { "Sec-Fetch-Site": "same-origin" },
      data: {},
    });
    expect(response.status()).toBe(401);
  });

  test("linked pull requests are shown on the task, both providers, with their state", async ({
    page,
  }) => {
    await seedLinkedPRs();
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);

    const pullRequest = page.getByRole("link", { name: new RegExp(`#${LINKED_PR_NUMBER}`) });
    await expect(pullRequest).toContainText(LINKED_PR_TITLE);
    await expect(pullRequest).toContainText("open");
    await expect(pullRequest).not.toContainText("GitLab");
    await expect(pullRequest).toHaveAttribute(
      "href",
      `https://github.com/example/board/pull/${LINKED_PR_NUMBER}`
    );

    const mergeRequest = page.getByRole("link", { name: new RegExp(`#${LINKED_MR_NUMBER}`) });
    await expect(mergeRequest).toContainText(LINKED_MR_TITLE);
    await expect(mergeRequest).toContainText("merged");
    await expect(mergeRequest).toContainText("GitLab");
    await expect(mergeRequest).toHaveAttribute(
      "href",
      `https://gitlab.com/example/board/-/merge_requests/${LINKED_MR_NUMBER}`
    );
  });

  test("the sync button follows the token, and not the repository", async ({ page }) => {
    await signIn(page);

    const cardBody = page.getByText("Links pull requests to tasks by task key", { exact: false });

    async function openGitHubCard() {
      await page.goto(SETTINGS);
      await page.getByRole("button", { name: "Integrations", exact: true }).first().click();
      const picker = page.getByRole("button", { name: /Add integration/ });
      const githubRow = page.getByRole("button", { name: /GitHub/ });
      await expect(picker.or(githubRow).or(cardBody).first()).toBeVisible();
      if (await picker.isVisible()) await picker.click();
      if (!(await cardBody.isVisible())) {
        await githubRow.first().click();
      }
      await expect(cardBody).toBeVisible();
    }

    const syncButton = page.getByRole("button", { name: "Sync pull requests now" });

    await openGitHubCard();
    await expect(syncButton).toHaveCount(0);

    await seedRepository({ githubToken: "e2e-token-never-called" });
    await openGitHubCard();
    await expect(syncButton).toBeVisible();
  });
});
