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

/**
 * BP-396 — what this instance does at its edges: webhook delivery, and the repository sync that
 * links a pull request to the task whose key it names.
 *
 * **Two of the four scenarios the task lists cannot be driven here, and are not faked.**
 *
 * *Webhook delivery to a local receiver.* A receiver on this machine cannot be delivered to at
 * all. `dispatchWebhooks` gates on `isAllowedWebhookUrl`, whose first line refuses anything that is
 * not https (`src/lib/url-validation.ts`), and `safeFetch` behind it refuses loopback and private
 * addresses by literal, by name, and by resolving every redirect hop (BP-303 — the sibling
 * `isAllowedMcpServerUrl` shows the loopback carve-out was a deliberate choice made for MCP and not
 * for webhooks). So no delivery can be received here and the signature it would carry cannot be
 * inspected.
 *
 * **Exactly one of those layers is asserted below, and it is the scheme.** A plain-HTTP receiver is
 * refused before the address is ever looked at, and giving the receiver an https face does not help:
 * with the address guards removed the app would open TLS against a plain-HTTP socket and record
 * nothing, so a delivered/not-delivered instrument cannot tell a fired guard from a failed
 * handshake. The address and name branches are unit-tested in `src/lib/safe-fetch.test.ts` and
 * `src/lib/private-address.ts`'s callers; claiming them here would be a second copy of a test this
 * file cannot actually run.
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

const signIn = arriveSignedIn;

test.beforeEach(seed);

test.describe("webhook delivery", () => {
  test.beforeEach(async ({ request }) => {
    await request.post(`${WEBHOOK_RECEIVER_URL}/reset`);
  });

  test("a board event is never delivered to an http endpoint", async ({ request }) => {
    // The control, first: the receiver records what reaches it, so the silence below is the app's
    // silence rather than an instrument that was never listening.
    const direct = await request.post(`${WEBHOOK_RECEIVER_URL}/control`, {
      headers: { "Content-Type": "application/json" },
      data: { probe: true },
    });
    expect(direct.status()).toBe(200);
    expect(await deliveries(request)).toHaveLength(1);

    // http, so `isAllowedWebhookUrl` refuses it on the scheme — see the note at the top of this
    // file for the layers below that one, and why they cannot be reached from here
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

  // Named for the rendering, not for the matching: the links are written to the task by the seed,
  // because the fetch that would produce them cannot run here. `matchPRsToTasks` could return
  // nothing at all and this would stay green — its own tests are in src/lib/github.test.ts.
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
      if (await picker.isVisible().catch(() => false)) await picker.click();
      if (!(await cardBody.isVisible().catch(() => false))) {
        await page.getByRole("button", { name: /GitHub/ }).first().click();
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
