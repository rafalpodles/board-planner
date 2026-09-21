import { test, expect, type Page } from "@playwright/test";
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
} from "./seed";
import { signIn as arriveSignedIn } from "./session";

/**
 * BP-396 — what this instance does at its edges: the repository sync that links a pull request to
 * the task whose key it names.
 *
 * *Webhook delivery* is received for real in `outbound-delivery.spec.ts` (BP-408), signature
 * included; the production refusal of a loopback or http address is `url-validation.test.ts`.
 *
 * There is no retry to test: delivery is single-shot by decision (BP-407), and its one outcome is
 * recorded on the webhook's row.
 *
 * *GitHub/GitLab sync against a stubbed service* is driven elsewhere, against `e2e/github-stub.mjs`
 * (`GITHUB_API_BASE_URL`, BP-443 — `pr-status.spec.ts`, `pr-link-pruning.spec.ts`) and
 * `e2e/gitlab-stub.mjs` (a project's own `gitlabHost`, BP-695 — `gitlab-activity.spec.ts`). This
 * file keeps the guards the sync routes apply before any fetch, and the rendering of a link.
 */

const SETTINGS = `/projects/${PROJECT_KEY}/settings`;

const signIn = arriveSignedIn;

test.beforeEach(seed);

test.describe("repository sync", () => {
  test("a project that names no repository is told so rather than reaching for one", async ({
    request,
  }) => {
    const response = await request.post(`/api/projects/${PROJECT_KEY}/github/sync`, {
      headers: ADMIN_AUTH,
      data: {},
    });
    expect(response.status()).toBe(400);
    // The whole sentence: the route answers this for a missing repository AND for a missing token,
    // so a fragment cannot tell which condition fired
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
    // No credential at all, so this is `withAuth` refusing — the grant check behind it is not
    // reached and is not claimed
    const response = await request.post(`/api/projects/${PROJECT_KEY}/github/sync`, {
      headers: { "Sec-Fetch-Site": "same-origin" },
      data: {},
    });
    expect(response.status()).toBe(401);
  });

  // Named for the rendering, not for the matching: the links are written to the task by the seed.
  // `matchPRsToTasks` could return nothing at all and this would stay green — the syncs that
  // produce links are driven in pr-status.spec.ts and gitlab-activity.spec.ts.
  test("linked pull requests are shown on the task, both providers, with their state", async ({
    page,
  }) => {
    await seedLinkedPRs();
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);

    const pullRequest = page.getByRole("link", { name: new RegExp(`#${LINKED_PR_NUMBER}`) });
    await expect(pullRequest).toContainText(LINKED_PR_TITLE);
    await expect(pullRequest).toContainText("open");
    // The provider chip is GitLab's alone; a GitHub row wearing one would be the same bug read
    // from the other side
    await expect(pullRequest).not.toContainText("GitLab");
    await expect(pullRequest).toHaveAttribute(
      "href",
      `https://github.com/example/board/pull/${LINKED_PR_NUMBER}`
    );

    const mergeRequest = page.getByRole("link", { name: new RegExp(`#${LINKED_MR_NUMBER}`) });
    await expect(mergeRequest).toContainText(LINKED_MR_TITLE);
    await expect(mergeRequest).toContainText("merged");
    // The provider is named on the row rather than left to be guessed from the URL
    await expect(mergeRequest).toContainText("GitLab");
    await expect(mergeRequest).toHaveAttribute(
      "href",
      `https://gitlab.com/example/board/-/merge_requests/${LINKED_MR_NUMBER}`
    );
  });

  test("the sync button follows the token, and not the repository", async ({ page }) => {
    await signIn(page);

    // The catalogue offers the GitHub card behind a picker on a board with nothing connected, and
    // beside the connected ones otherwise — the same two shapes openWebhooks handles in
    // settings-save.spec.ts
    const cardBody = page.getByText("Links pull requests to tasks by task key", { exact: false });

    async function openGitHubCard() {
      await page.goto(SETTINGS);
      await page.getByRole("button", { name: "Integrations", exact: true }).first().click();
      const picker = page.getByRole("button", { name: /Add integration/ });
      // Three shapes, not two: the picker on a board with nothing connected, the GitHub row
      // beside the connected ones, and the opened card's own body. Which one this is cannot be
      // read until one of them is on screen — an isVisible() before that answers false
      // immediately and takes the wrong branch, which is what retried this test on CI run
      // 32816339185.
      const githubRow = page.getByRole("button", { name: /GitHub/ });
      await expect(picker.or(githubRow).or(cardBody).first()).toBeVisible();
      if (await picker.isVisible()) await picker.click();
      if (!(await cardBody.isVisible())) {
        await githubRow.first().click();
      }
      // The card's own body, not the repository field beside it: that field renders whether or not
      // this card was ever opened, so an absent button below would otherwise be a reading of the
      // page rather than of the card
      await expect(cardBody).toBeVisible();
    }

    const syncButton = page.getByRole("button", { name: "Sync pull requests now" });

    await openGitHubCard();
    await expect(syncButton).toHaveCount(0);

    // A token and no repository. The component's condition is `githubTokenSet` alone, so the button
    // appears here — the missing repository is caught by the route, which answers 400 (asserted
    // above) rather than by hiding the button.
    await seedRepository({ githubToken: "e2e-token-never-called" });
    await openGitHubCard();
    await expect(syncButton).toBeVisible();
  });
});
