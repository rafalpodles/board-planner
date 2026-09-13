import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { logActivity } from "@/lib/activity";
import { GITHUB_STUB_URL } from "../playwright.config";
import { ADMIN_AUTH } from "./api";
import {
  E2E_MONGODB_URI,
  PROJECT_ID,
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

/** The task's History tab, once its rows are in — the empty line is also the loading state. */
async function openHistory(page: Page, taskNumber: number): Promise<Locator> {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${taskNumber}`);
  await page.getByRole("tab", { name: /^History/ }).click();
  const panel = page.locator("#task-panel-history");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("No history yet")).toBeHidden();
  const showAll = page.getByRole("button", { name: /Show all \d+ entries/ });
  if (await showAll.isVisible()) await showAll.click();
  return panel;
}

async function openTheTask(page: Page, taskNumber: number, title: string) {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${taskNumber}`);
  await expect(page.getByLabel("Task title").first()).toHaveValue(title);
}

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

test.beforeEach(async () => {
  await seed();
  await seedRepository({ repositoryUrl: REPO, githubToken: SEEDED_TOKEN });
});

test.afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("a pull request that has left the window is kept when a newer one arrives", async ({
  page,
  request,
}) => {
  const branch = `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}/first`;
  await github(request, [pull(9, branch)]);
  await syncNow(request);
  expect(await linksOn(request, SIBLING_TASK_NUMBER)).toEqual([9]);

  // The window has moved on and only the newer pull request comes back. Nothing says 9 stopped
  // being this task's, and the sync must not read its own blind spot as a contradiction.
  //
  // Not narrated as "9 has aged past the thirty closed ones": `pull()` builds an OPEN pull request
  // and GitHub's window holds every one of those, so that story could not happen (found in
  // review). What this drives is the shape that matters — a round that does not mention 9 — and
  // the real ways to get one are a closed pull request ageing out, a fetch that failed, or a
  // repository whose open list is longer than the page.
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

/**
 * The link shape the second pass has to find and nothing else can see: written before the
 * `provider` field existed, so it carries none. The schema's `default: "github"` is applied on
 * hydration rather than stored, so a query for `provider: "github"` misses it — and this is the
 * query, against a real database, which is the only place that can be shown.
 */
test("a link stored before the provider field existed is pruned too", async ({ request }) => {
  const handle = await db();
  const task = await handle
    .collection("tasks")
    .findOne({ project: new mongoose.Types.ObjectId(PROJECT_ID), taskNumber: SIBLING_TASK_NUMBER });
  await handle.collection("tasks").updateOne(
    { _id: task!._id },
    {
      $set: {
        linkedPRs: [
          {
            _id: new mongoose.Types.ObjectId(),
            number: 41,
            title: "written before providers existed",
            state: "open",
            url: `${REPO}/pull/41`,
            mergedAt: null,
            updatedAt: new Date("2026-08-01T00:00:00Z"),
          },
        ],
      },
    }
  );
  expect(await linksOn(request, SIBLING_TASK_NUMBER)).toEqual([41]);

  // The round sees 41 and gives it to another task, so the sibling's copy is contradicted
  await github(request, [pull(41, "feat/no-key", { title: `${PROJECT_KEY}-${DECOY_TASK_NUMBER} mine now` })]);
  const result = await syncNow(request);

  expect(await linksOn(request, SIBLING_TASK_NUMBER)).toEqual([]);
  expect(await linksOn(request, DECOY_TASK_NUMBER)).toEqual([41]);
  expect(result.prsUnlinked).toBe(1);
});

/**
 * BP-631. `seen` used to be bare numbers, and a number is only unique inside one repository. A
 * project repointed at a different repository therefore had the *old* one's links pruned by the
 * new one's numbers — a real pull request, deleted over a collision the round never observed.
 *
 * Driven against a real database because the rule lives in three places that have to agree: the
 * `$filter` in the pipeline, the counting in `pr-links.ts`, and the query that finds the tasks a
 * round contradicts without visiting.
 */
test("a repointed project keeps the previous repository's pull request", async ({
  page,
  request,
}) => {
  const handle = await db();
  const task = await handle
    .collection("tasks")
    .findOne({ project: new mongoose.Types.ObjectId(PROJECT_ID), taskNumber: SIBLING_TASK_NUMBER });
  await handle.collection("tasks").updateOne(
    { _id: task!._id },
    {
      $set: {
        linkedPRs: [
          {
            _id: new mongoose.Types.ObjectId(),
            provider: "github",
            number: 41,
            title: "Opened before the project moved",
            state: "open",
            url: "https://github.com/example/previous/pull/41",
            mergedAt: null,
            updatedAt: new Date("2026-08-01T00:00:00Z"),
          },
        ],
      },
    }
  );

  // The project now names a different repository, and its 41 is a different pull request
  await github(request, [pull(41, `${PROJECT_KEY}-${DECOY_TASK_NUMBER}/mine`)]);
  const result = await syncNow(request);

  expect(result.prsUnlinked).toBe(0);
  expect(await linksOn(request, SIBLING_TASK_NUMBER)).toEqual([41]);
  // The control: the round was not a no-op — it gave its own 41 to the task its branch names
  expect(await linksOn(request, DECOY_TASK_NUMBER)).toEqual([41]);

  await signIn(page);
  await openTheTask(page, SIBLING_TASK_NUMBER, SIBLING_TASK_TITLE);
  await expect(
    page.getByRole("link", { name: /#41/ })
  ).toHaveAttribute("href", "https://github.com/example/previous/pull/41");
});

/**
 * BP-628 and BP-632. `updatedAt` stopped moving on a link change, no webhook fires from either
 * sync route, and no row was written — so a link arriving on a task, or leaving it, left the task
 * itself saying nothing. This is the row, read off the screen a person would look at.
 */
test("a link arriving and leaving is written into the task's own history", async ({
  page,
  request,
}) => {
  await github(request, [pull(77, `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}/first`)]);
  await syncNow(request);

  await signIn(page);
  let history = await openHistory(page, SIBLING_TASK_NUMBER);
  await expect(
    history.getByText(`E2E Admin linked github.com/example/board/pull/77`)
  ).toBeVisible();

  // Retitled onto another task: the link leaves, which is the direction with nowhere else to look
  await github(request, [
    pull(77, "feat/no-key-at-all", { title: `${PROJECT_KEY}-${DECOY_TASK_NUMBER} moved` }),
  ]);
  expect((await syncNow(request)).prsUnlinked).toBe(1);

  history = await openHistory(page, SIBLING_TASK_NUMBER);
  await expect(
    history.getByText(`E2E Admin unlinked github.com/example/board/pull/77`)
  ).toBeVisible();
  // And the row it left on the task that gained it
  const gained = await openHistory(page, DECOY_TASK_NUMBER);
  await expect(
    gained.getByText(`E2E Admin linked github.com/example/board/pull/77`)
  ).toBeVisible();
});

/**
 * The control for both rows above: a round that changes no link writes no history. Without it,
 * a sync that wrote a row on every tick would pass the two tests above and bury the task's real
 * history under "the sync looked again" five minutes apart.
 */
test("a round that only looked again writes nothing", async ({ page, request }) => {
  await github(request, [pull(78, `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}/first`)]);
  await syncNow(request);
  await syncNow(request);

  await signIn(page);
  const history = await openHistory(page, SIBLING_TASK_NUMBER);

  await expect(
    history.getByText(`E2E Admin linked github.com/example/board/pull/78`)
  ).toHaveCount(1);
});

/**
 * The row a **scheduled** round leaves, which is the one with no person to name (BP-628, BP-632).
 *
 * The tick cannot be driven from a browser — it runs on an interval inside the server — so what is
 * driven here is everything the tick's row passes through afterwards: a schema that used to
 * require a user, `logActivity`'s own catch, which would have swallowed the refusal in silence,
 * the route that populates the reference, and the sentence the panel builds from an absence that
 * looks exactly like a deleted account.
 */
test("a row the scheduled sync wrote names the sync, not Unknown", async ({ page }) => {
  const handle = await db();
  const task = await handle
    .collection("tasks")
    .findOne({ project: new mongoose.Types.ObjectId(PROJECT_ID), taskNumber: SIBLING_TASK_NUMBER });

  await logActivity(
    String(task!._id),
    null,
    "pr_unlinked",
    "linkedPRs",
    `${REPO}/pull/91`,
    ""
  );

  await signIn(page);
  const history = await openHistory(page, SIBLING_TASK_NUMBER);

  await expect(
    history.getByText("The repository sync unlinked github.com/example/board/pull/91")
  ).toBeVisible();
  // The control: a deleted author is the same absence in the database and must still read as one
  await handle.collection("activitylogs").insertOne({
    task: task!._id,
    user: null,
    action: "comment_added",
    field: "",
    oldValue: "",
    newValue: "",
    createdAt: new Date(),
  });
  const again = await openHistory(page, SIBLING_TASK_NUMBER);
  await expect(again.getByText("Unknown added a comment")).toBeVisible();
});
