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

/**
 * BP-396 — what this instance does at its edges: webhook delivery, and the repository sync that
 * links a pull request to the task whose key it names.
 *
 * **Two of the four scenarios the task lists cannot be driven here, and are not faked.**
 *
 * *Webhook delivery to a local receiver.* `dispatchWebhooks` goes through `safeFetch`, which
 * accepts https and a public address only, with no loopback carve-out (BP-303, and the sibling
 * `isAllowedMcpServerUrl` shows the carve-out was a deliberate choice made for MCP and not for
 * webhooks). Every route to a receiver on this machine is closed: http is refused by scheme,
 * 127.0.0.1 by literal, `localhost` and `*.local` by name, and a public name that resolves inward
 * by the DNS check at every redirect hop. So a delivery cannot be received here, and the header it
 * would carry cannot be inspected — which leaves the guard itself as the thing worth asserting,
 * and it is asserted below with a receiver that demonstrably records what it is sent.
 *
 * There is also no retry to test: `dispatchWebhooks` fires once and swallows the outcome
 * (`.catch(() => {})`). The task's "retry after failure" describes behaviour the code does not
 * have; it is reported on the task rather than invented here.
 *
 * *GitHub/GitLab sync against a stubbed service.* `fetchPullRequests` names `api.github.com` in
 * the source with no injectable base, and GitLab's host, though configurable, goes through the
 * same `safeFetch` refusal. What is reachable is asserted: every guard the sync route applies
 * before the fetch, and the linking those calls exist to produce.
 */

const SETTINGS = `/projects/${PROJECT_KEY}/settings`;

interface Delivery {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * A delivery that never happens has no event to wait for, so the window has to be spent rather
 * than polled: `expect.poll(...).toBe(0)` is satisfied by the first reading and returns before the
 * app has had a chance to send anything. Measured against a build with both destination guards
 * removed, the delivery lands in single-digit milliseconds; two seconds is three orders of
 * magnitude of room.
 */
const SETTLE_MS = 2_000;

/** What the receiver has been sent since the last reset. */
async function deliveries(request: APIRequestContext): Promise<Delivery[]> {
  const response = await request.get(`${WEBHOOK_RECEIVER_URL}/deliveries`);
  expect(response.status()).toBe(200);
  return response.json();
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN_USERNAME);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);
}

test.beforeEach(seed);

test.describe("webhook delivery", () => {
  test.beforeEach(async ({ request }) => {
    await request.post(`${WEBHOOK_RECEIVER_URL}/reset`);
  });

  test("a board event is never delivered to an address on this machine", async ({ request }) => {
    // The control, first: the receiver records what reaches it, so the silence below is the app's
    // silence rather than an instrument that was never listening.
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

    // Still recording, after the window the app had
    await request.post(`${WEBHOOK_RECEIVER_URL}/control`, {
      headers: { "Content-Type": "application/json" },
      data: { probe: "again" },
    });
    expect((await deliveries(request)).filter((d) => d.url === "/control")).toHaveLength(2);
  });

  test("a name that resolves inward is refused too, before DNS", async ({ request }) => {
    await seedWebhook(`${WEBHOOK_RECEIVER_URL.replace("127.0.0.1", "localhost")}/hook`);

    const created = await request.post(`/api/projects/${PROJECT_KEY}/tasks`, {
      headers: ADMIN_AUTH,
      data: { title: "A second event", status: "todo" },
    });
    expect(created.status()).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    expect(await deliveries(request)).toHaveLength(0);
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
    expect((await response.json()).error).toContain("must be configured");
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

  test("a sync a person cannot reach the project for is refused", async ({ request }) => {
    const response = await request.post(`/api/projects/${PROJECT_KEY}/github/sync`, {
      headers: { "Sec-Fetch-Site": "same-origin" },
      data: {},
    });
    expect(response.status()).toBe(401);
  });

  test("the pull requests a sync matched are on the task, both providers, with their state", async ({
    page,
  }) => {
    await seedLinkedPRs();
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);

    const pullRequest = page.getByRole("link", { name: new RegExp(`#${LINKED_PR_NUMBER}`) });
    await expect(pullRequest).toContainText(LINKED_PR_TITLE);
    await expect(pullRequest).toContainText("open");
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

  test("the sync button appears only once a repository and a token are configured", async ({
    page,
  }) => {
    await signIn(page);

    // The catalogue offers the GitHub card behind a picker on a board with nothing connected, and
    // beside the connected ones otherwise — the same two shapes openWebhooks handles in
    // settings-save.spec.ts
    async function openGitHubCard() {
      await page.goto(SETTINGS);
      await page.getByRole("button", { name: "Integrations", exact: true }).first().click();
      const picker = page.getByRole("button", { name: /Add integration/ });
      if (await picker.isVisible().catch(() => false)) await picker.click();
      const token = page.getByPlaceholder(/ghp_|token/i).first();
      if (!(await token.isVisible().catch(() => false))) {
        await page.getByRole("button", { name: /GitHub/ }).first().click();
      }
      // The card is open: its own field is on screen, so an absent Sync button below is a reading
      // of the card rather than of a page that never rendered it
      await expect(page.getByPlaceholder("https://github.com/owner/repo")).toBeVisible();
    }

    // Nothing configured: the action that would call GitHub is not offered
    await openGitHubCard();
    await expect(page.getByRole("button", { name: "Sync pull requests now" })).toHaveCount(0);

    // The control. Without it "the button is absent" is satisfied by a settings page that failed
    // to render the GitHub card at all, which is the same reading for a different reason.
    await seedRepository({
      repositoryUrl: "https://github.com/example/board",
      githubToken: "e2e-token-never-called",
    });
    await openGitHubCard();
    await expect(page.getByRole("button", { name: "Sync pull requests now" })).toBeVisible();
  });
});
