import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { GITHUB_STUB_URL } from "../playwright.config";
import { ADMIN_AUTH } from "./api";
import {
  PROJECT_KEY,
  SIBLING_TASK_NUMBER,
  SIBLING_TASK_TITLE,
  seed,
  seedRepository,
} from "./seed";
import { signIn as arriveSignedIn } from "./session";

/**
 * BP-443. What a pull request's build says, on the board.
 *
 * This is the first spec in the suite to drive a repository sync at all. Until BP-443 made the
 * API's address injectable, `fetchPullRequests` named `api.github.com` in the source, so
 * `external-integrations.spec.ts` asserted only the guards in front of the fetch and `seed.ts`
 * planted the links a sync would have produced. Here the sync runs: `e2e/github-stub.mjs` answers
 * as GitHub, and the matcher, the check reduction, the pipeline that writes the links and the
 * badge that reads them are all the production path.
 *
 * The colour is never what is asserted. Green and red on a badge this size are the pair colour
 * blindness separates worst, so the state travels in `data-look` and in the sentence the badge
 * carries — which is also what a screen reader gets.
 */

const signIn = arriveSignedIn;

const REPO = "https://github.com/example/board";
const HEAD = "c0ffee1";

/** A pull request in GitHub's own shape, matched to the seeded sibling task by its branch. */
function pull(over: Partial<Record<string, unknown>> = {}) {
  return {
    number: 41,
    title: "Keep the header visible",
    state: "open",
    html_url: `${REPO}/pull/41`,
    merged_at: null,
    head: { ref: `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}/keep-the-header`, sha: HEAD },
    updated_at: "2026-09-01T00:00:00Z",
    ...over,
  };
}

const passing = { check_runs: [{ name: "e2e", status: "completed", conclusion: "success" }] };
const failing = { check_runs: [{ name: "e2e", status: "completed", conclusion: "failure" }] };
const running = { check_runs: [{ name: "e2e", status: "in_progress", conclusion: null }] };

/** What the stub will answer with from here on, and a reset of what it has been asked. */
async function github(
  request: APIRequestContext,
  scenario: { pulls: unknown[]; checks?: Record<string, unknown> }
) {
  const response = await request.post(`${GITHUB_STUB_URL}/control`, {
    data: { pulls: scenario.pulls, checks: scenario.checks ?? {} },
  });
  expect(response.status()).toBe(200);
}

/** Every path the app has asked GitHub for since the last `github()` call. */
async function askedFor(request: APIRequestContext): Promise<string[]> {
  return (await request.get(`${GITHUB_STUB_URL}/asked`)).json();
}

async function syncNow(request: APIRequestContext) {
  const response = await request.post(`/api/projects/${PROJECT_KEY}/github/sync`, {
    headers: ADMIN_AUTH,
    data: {},
  });
  // Read rather than assumed: a sync that refused answers 400 with a sentence, and a spec that
  // went straight to the board would then be asserting an empty badge against an empty board
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

/** The card's and the detail's badge, which is state and not a link. */
const state = (page: Page) => page.getByTestId("pr-state");
/** The list row's badge, which is a link because nothing encloses it there. */
const badge = (page: Page) => page.getByTestId("pr-badge");

async function openTheList(page: Page) {
  await page.getByRole("button", { name: "List", exact: true }).click();
}

test.beforeEach(async () => {
  await seed();
  await seedRepository({ repositoryUrl: REPO, githubToken: "e2e-token-passed-through" });
});

test.describe("the badge on the board", () => {
  test("carries what CI said, and the name of the check that decided it", async ({
    page,
    request,
  }) => {
    await github(request, { pulls: [pull()], checks: { [HEAD]: failing } });
    await syncNow(request);

    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}`);

    await expect(state(page)).toHaveAttribute("data-look", "failure");
    await expect(state(page)).toContainText("#41");
    await expect(page.getByText("#41 Keep the header visible — e2e failed")).toBeAttached();
  });

  test("says passing, running and unknown apart", async ({ page, request }) => {
    await signIn(page);

    for (const [checks, look, sentence] of [
      [passing, "success", /e2e passed/],
      [running, "running", /e2e running/],
      // The one state GitHub never reports: the app's own answer for a question it could not ask
      ["refuse", "unknown", /could not be read/],
    ] as const) {
      await github(request, { pulls: [pull()], checks: { [HEAD]: checks } });
      await syncNow(request);
      await page.goto(`/projects/${PROJECT_KEY}`);

      await expect(state(page), look).toHaveAttribute("data-look", look);
      await expect(state(page).getByText(sentence), look).toBeAttached();
    }
  });

  /**
   * A merged pull request reads as merged, and that is all this can claim.
   *
   * `pullRequestLook` also says a merge outranks a failing build, and the checks below are failing
   * — but that rule is unreachable from here and the test was written before that was noticed: the
   * sync never asks a finished pull request about its checks, so what is stored is `ci: "none"` and
   * the precedence never fires. Watched staying green against a build with the precedence inverted,
   * which is what proved it. The rule is defensive, and `PullRequestBadge.test.tsx` pins it where
   * the state can be constructed.
   */
  test("shows a merged pull request as merged", async ({ page, request }) => {
    await github(request, {
      pulls: [pull({ state: "closed", merged_at: "2026-09-02T00:00:00Z" })],
      checks: { [HEAD]: failing },
    });
    await syncNow(request);

    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}`);

    await expect(state(page)).toHaveAttribute("data-look", "merged");
    await expect(state(page).getByText(/— merged$/)).toBeAttached();
  });

  /**
   * Not a link on the card, and that is the decision rather than an oversight: the card is itself
   * one `<a>`, and `TaskCard` says in place why nothing interactive goes inside one. The list row
   * is a `<tr>`, so the badge there is the link — asserted below.
   */
  test("is not a second link inside the card's own link", async ({ page, request }) => {
    await github(request, { pulls: [pull()], checks: { [HEAD]: passing } });
    await syncNow(request);

    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}`);

    await expect(state(page)).toBeVisible();
    await expect(state(page).locator("a")).toHaveCount(0);
    // The control: the card is still the link it was, and the badge did not take that away
    await expect(page.locator(`a[href$="/tasks/${SIBLING_TASK_NUMBER}"]`).first()).toBeVisible();
  });
});

test("the list view carries the same badge", async ({ page, request }) => {
  await github(request, { pulls: [pull()], checks: { [HEAD]: failing } });
  await syncNow(request);

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await openTheList(page);
  // A positive assertion only a loaded list can satisfy, before anything is read off a row
  await expect(page.getByRole("cell", { name: SIBLING_TASK_TITLE })).toBeVisible();

  await expect(badge(page)).toHaveAttribute("data-look", "failure");
  // Where the ticket's "clicking the badge opens the pull request" lives: nothing encloses this
  // one, so it is a real link
  await expect(badge(page)).toHaveAttribute("href", `${REPO}/pull/41`);
  await expect(badge(page)).toHaveAttribute("target", "_blank");
});

/**
 * The rate-limit rule and the "stop polling what has finished" rule are the same rule, and this is
 * where it can be seen: the stub records every path it was asked for.
 */
test("a finished pull request is never asked about", async ({ request }) => {
  await github(request, {
    pulls: [
      pull({ state: "closed", merged_at: "2026-09-02T00:00:00Z" }),
      pull({ number: 42, html_url: `${REPO}/pull/42`, head: { ref: `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}/other`, sha: "beef2" } }),
    ],
    checks: { beef2: passing },
  });

  await syncNow(request);
  const asked = await askedFor(request);

  // The control, first: the open one was asked about, so the silence below is a rule and not a
  // sync that never reached GitHub at all
  expect(asked.filter((path) => path.includes("/commits/beef2/"))).toHaveLength(2);
  expect(asked.filter((path) => path.includes(`/commits/${HEAD}/`))).toEqual([]);
});

/**
 * The manual refresh, end to end: the badge is red, the build is fixed, and the person looking at
 * the task asks again without leaving it.
 */
test("refreshing a task picks up a build that has since gone green", async ({ page, request }) => {
  await github(request, { pulls: [pull()], checks: { [HEAD]: failing } });
  await syncNow(request);

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
  await expect(page.getByTestId("pr-state")).toHaveAttribute("data-look", "failure");
  await expect(page.getByTestId("pr-state")).toContainText("e2e failed");

  await github(request, { pulls: [pull()], checks: { [HEAD]: passing } });
  const refreshed = page.waitForResponse(
    (r) => new URL(r.url()).pathname === `/api/projects/${PROJECT_KEY}/github/sync` && r.status() === 200
  );
  await page.getByRole("button", { name: "Refresh PR status" }).click();
  await refreshed;

  await expect(page.getByTestId("pr-state")).toHaveAttribute("data-look", "success");
  await expect(page.getByTestId("pr-state")).toContainText("e2e passed");
});

// The refusal a person sees when the project has no token to ask with — the message the route
// gave, not one the screen invented
test("a refused refresh says which refusal it was", async ({ page, request }) => {
  await github(request, { pulls: [pull()], checks: { [HEAD]: passing } });
  await syncNow(request);
  await seedRepository({ repositoryUrl: REPO, githubToken: "" });

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
  await page.getByRole("button", { name: "Refresh PR status" }).click();

  await expect(
    page.getByText("A repository URL and a GitHub token must be configured in project settings")
  ).toBeVisible();
});

// Nothing above reads the badge for a project whose links predate BP-443, so this is the control
// for every one of them: a link with no `ci` recorded is simply open, not unknown and not green
test("a link stored before any of this reads as open", async ({ page, request }) => {
  await github(request, { pulls: [pull()], checks: { [HEAD]: { check_runs: [] } } });
  await syncNow(request);

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);

  await expect(state(page)).toHaveAttribute("data-look", "open");
  await expect(state(page).getByText(/— open$/)).toBeAttached();
});

test("the sync reaches the stub and not the real GitHub", async ({ request }) => {
  await github(request, { pulls: [pull()], checks: { [HEAD]: passing } });

  const body = await syncNow(request);

  expect(body).toMatchObject({ synced: true, prsFound: 1, tasksLinked: 1, prsLinked: 1 });
  expect(await askedFor(request)).toContain("/repos/example/board/pulls");
});
