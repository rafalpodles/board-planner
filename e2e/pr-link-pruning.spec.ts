import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { pruneContradictedLinks, removeProviderLinks, writeProviderLinks } from "@/lib/pr-links";
import { Task } from "@/models/task";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed, seedRepository, taskFactory } from "./seed";
import { signIn } from "./session";

/**
 * BP-610. A sync wrote only the tasks in its own grouping, so a pull request that stopped matching
 * a task took that task out of the loop and left the stale link on the card for ever.
 *
 * What runs here is the real second pass against the real database. A unit test can assert which
 * numbers the decision names, and nothing more: `$$this` inside `$filter`, `$ifNull` against a
 * field an older document does not have, `$in` against a literal array and a query that has to
 * match a missing field are all parts a mocked model agrees with while they are wrong. The last
 * test then reads the result off the screen, because a link the database no longer holds is only
 * fixed if the badge goes with it.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

// Away from the seed's numbers and from each other, as its sibling spec does: nothing here goes
// through the counter that hands out task numbers, and `project_1_taskNumber_1` is unique.
let nextNumber = 800_000 + Math.floor(Math.random() * 90_000);

function link(provider: "github" | "gitlab" | null, number: number, url?: string) {
  const doc: Record<string, unknown> = {
    _id: new mongoose.Types.ObjectId(),
    number,
    title: `PR ${number}`,
    state: "open",
    url: url ?? `https://github.com/example/board/pull/${number}`,
    mergedAt: null,
    updatedAt: new Date("2026-08-01T00:00:00Z"),
  };
  if (provider) doc.provider = provider;
  return doc;
}

async function taskWith(linkedPRs: Record<string, unknown>[] | undefined, over: Record<string, unknown> = {}) {
  const handle = await db();
  const _id = new mongoose.Types.ObjectId();
  const doc = taskFactory(new Date())({
    _id,
    title: "PR link pruning",
    taskNumber: nextNumber++,
    status: "todo",
    ...over,
  }) as Record<string, unknown>;
  // `undefined` leaves the field absent, which is the state of every task written before the
  // linking work — `$ifNull` in the pipeline is the only reason it survives one.
  if (linkedPRs) doc.linkedPRs = linkedPRs;
  else delete doc.linkedPRs;
  await handle.collection("tasks").insertOne(doc);
  return { _id, taskNumber: doc.taskNumber as number };
}

async function linksOf(_id: mongoose.Types.ObjectId) {
  const handle = await db();
  const found = await handle.collection("tasks").findOne({ _id });
  return (found?.linkedPRs ?? []) as Record<string, unknown>[];
}

const prune = (over: Record<string, unknown> = {}) =>
  pruneContradictedLinks({
    projectId: String(PROJECT_ID),
    provider: "github",
    linkedThisRound: new Set<number>(),
    seenNumbers: new Set<number>(),
    ...over,
  });

test.beforeEach(seed);

test.afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("the pipeline removes the named links and leaves the rest of the array", async () => {
  const { _id } = await taskWith([link("github", 7001), link("github", 7002)]);
  await db();

  await Task.updateOne({ _id }, removeProviderLinks("github", [7001]), { updatePipeline: true });

  expect((await linksOf(_id)).map((l) => l.number)).toEqual([7002]);
});

test("a GitHub prune cannot reach GitLab's links, whatever the numbers are", async () => {
  const { _id } = await taskWith([link("github", 7003), link("gitlab", 7003)]);
  await db();

  await Task.updateOne({ _id }, removeProviderLinks("github", [7003]), { updatePipeline: true });

  const links = await linksOf(_id);
  expect(links.map((l) => [l.provider, l.number])).toEqual([["gitlab", 7003]]);
});

test("a link stored before the provider field existed is GitHub's to remove", async () => {
  const legacy = await taskWith([link(null, 7004)]);
  const spared = await taskWith([link(null, 7005)]);
  await db();

  await Task.updateOne({ _id: legacy._id }, removeProviderLinks("github", [7004]), {
    updatePipeline: true,
  });
  await Task.updateOne({ _id: spared._id }, removeProviderLinks("gitlab", [7005]), {
    updatePipeline: true,
  });

  expect(await linksOf(legacy._id)).toEqual([]);
  expect((await linksOf(spared._id)).map((l) => l.number)).toEqual([7005]);
});

/**
 * The query, not the pipeline. A document written before the provider field existed has no
 * `provider` key at all — the schema's default is applied when Mongoose hydrates one, never when
 * one is stored — so `{"linkedPRs.provider": "github"}`, which is what the ticket proposed, finds
 * none of them and they are stale for ever.
 */
test("the sweep finds a holder whose link predates the provider field", async () => {
  const { _id } = await taskWith([link(null, 7006)]);

  const removed = await prune({ seenNumbers: new Set([7006]) });

  expect(removed).toBeGreaterThanOrEqual(1);
  expect(await linksOf(_id)).toEqual([]);
});

/**
 * The half that matters more than the removal. GitHub is asked for its open pull requests plus the
 * thirty most recently updated closed ones; a task whose pull request merged last quarter is
 * outside that on every sync while being perfectly correct.
 */
test("a link this round never saw survives the sweep", async () => {
  const { _id } = await taskWith([link("github", 7007)]);

  const removed = await prune({ seenNumbers: new Set([7008, 7009]) });

  expect(removed).toBe(0);
  expect((await linksOf(_id)).map((l) => l.number)).toEqual([7007]);
});

/**
 * The dashboard reads a done task's `updatedAt` as the date it was finished
 * (`src/app/api/projects/[projectId]/stats/route.ts`), and taking a stale link off a task that was
 * finished last quarter is not that task being finished today — it would move on the chart, and
 * `$gte: since` would pull it into a window it does not belong to. Mongoose stamps `updatedAt` on
 * an update unless told not to, including a pipeline one, so only a real write can show it obeyed.
 */
test("cleaning up a link is not the task being touched", async () => {
  const finished = new Date("2026-01-05T09:00:00.000Z");
  const { _id } = await taskWith([link("github", 7016)], {
    status: "done",
    updatedAt: finished,
  });

  const removed = await prune({ seenNumbers: new Set([7016]) });

  expect(removed).toBe(1);
  expect(await linksOf(_id)).toEqual([]);
  const handle = await db();
  const after = await handle.collection("tasks").findOne({ _id });
  expect(after?.updatedAt).toEqual(finished);
});

test("a task the round rewrote wholesale is left to that write", async () => {
  const { _id, taskNumber } = await taskWith([link("github", 7011)]);

  const removed = await prune({
    seenNumbers: new Set([7011]),
    linkedThisRound: new Set([taskNumber]),
  });

  expect(removed).toBe(0);
  expect((await linksOf(_id)).map((l) => l.number)).toEqual([7011]);
});

/**
 * A removal and the other provider's write compose, whichever order the database applies them in
 * — which is the property BP-559's pipelines buy, and all this can honestly claim. MongoDB
 * serialises updates to one document, so `Promise.all` observes no interleaving and this would
 * pass under a serial run too; what it would catch is either write reading the array into JS and
 * putting back a copy.
 */
test("a removal and the other provider's write compose in either order", async () => {
  const { _id } = await taskWith([link("github", 7012)]);
  await db();

  await Promise.all([
    Task.updateOne({ _id }, removeProviderLinks("github", [7012]), { updatePipeline: true }),
    writeProviderLinks(_id, "gitlab", [
      {
        provider: "gitlab" as const,
        number: 7013,
        title: "MR 7013",
        state: "open",
        url: "https://gitlab.com/example/board/-/merge_requests/7013",
        mergedAt: null,
        updatedAt: new Date("2026-08-01T00:00:00Z"),
      },
    ]),
  ]);

  const links = await linksOf(_id);
  expect(links.map((l) => l.number)).toEqual([7013]);
});

test("the badge goes with the link", async ({ page }) => {
  const stale = link("github", 7014);
  const kept = {
    ...link("gitlab", 7015, "https://gitlab.com/example/board/-/merge_requests/7015"),
    provider: "gitlab",
  };
  const { _id, taskNumber } = await taskWith([stale, kept], { title: "Retitled away" });

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${taskNumber}`);
  // The control: both rows are on the screen before the sweep, so their absence afterwards is the
  // sweep's doing rather than a page that never rendered them.
  await expect(page.getByRole("link", { name: /#7014/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /#7015/ })).toBeVisible();

  await prune({ seenNumbers: new Set([7014]) });
  await page.reload();

  await expect(page.getByRole("link", { name: /#7015/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /#7014/ })).toHaveCount(0);
  expect((await linksOf(_id)).map((l) => l.number)).toEqual([7015]);
});

/**
 * Removal is the one destructive thing a sync does, and until BP-610 it was also the only one the
 * operator was never told about — the toast counted what was linked and what moved, and said
 * nothing about links that went. A wrong deletion has to be discoverable at the moment it happens.
 *
 * The response is stubbed rather than fetched: `fetchPullRequests` names api.github.com in the
 * code and cannot be reached from here (the note at the top of external-integrations.spec.ts), and
 * the subject of this test is what the settings screen does with the number, not where it comes
 * from.
 */
async function openSyncCard(page: import("@playwright/test").Page, provider: "github" | "gitlab") {
  const body =
    provider === "github"
      ? "Links pull requests to tasks by task key"
      : "Same matching as GitHub, for merge requests";
  const cardBody = page.getByText(body, { exact: false });
  const picker = page.getByRole("button", { name: /Add integration/ });
  const row = page.getByRole("button", { name: provider === "github" ? /GitHub/ : /GitLab/ });

  await page.goto(`/projects/${PROJECT_KEY}/settings`);
  await page.getByRole("button", { name: "Integrations", exact: true }).first().click();
  // Three shapes, as external-integrations.spec.ts found: the picker on a board with nothing
  // connected, the provider's row beside the connected ones, and the opened card's own body.
  await expect(picker.or(row).or(cardBody).first()).toBeVisible();
  if (await picker.isVisible()) await picker.click();
  if (!(await cardBody.isVisible())) await row.first().click();
  await expect(cardBody).toBeVisible();
}

function stubSync(
  page: import("@playwright/test").Page,
  provider: "github" | "gitlab",
  prsUnlinked: number
) {
  return page.route(`**/api/projects/*/${provider}/sync`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        synced: true,
        prsFound: 2,
        tasksLinked: 1,
        prsLinked: 2,
        prsUnlinked,
        autoTransitioned: 0,
      }),
    })
  );
}

/**
 * Removal is the one destructive thing a sync does, and until BP-610 it was also the only one the
 * operator was never told about — the toast counted what was linked and what moved, and said
 * nothing about links that went. A wrong deletion has to be discoverable at the moment it happens.
 *
 * The response is stubbed rather than fetched: `fetchPullRequests` names api.github.com in the
 * code and cannot be reached from here (the note at the top of external-integrations.spec.ts), and
 * the subject is what the settings screen does with the number. What the stub cannot check — that
 * the route really calls the field `prsUnlinked` — is checked by the compiler instead: both routes
 * and this screen are typed against `ApiRepositorySyncResult`, so renaming it on one side alone
 * does not build.
 */
for (const provider of ["github", "gitlab"] as const) {
  const noun = provider === "github" ? "PRs" : "MRs";
  const button = provider === "github" ? "Sync pull requests now" : "Sync merge requests now";

  test(`the ${provider} sync toast says how many links it took away`, async ({ page }) => {
    await seedRepository(
      provider === "github"
        ? { repositoryUrl: "https://github.com/example/board", githubToken: "e2e-token-never-called" }
        : {
            repositoryUrl: "https://gitlab.com/example/board",
            gitlabToken: "e2e-token-never-called",
            gitlabHost: "https://gitlab.com",
          }
    );
    await stubSync(page, provider, 3);
    await signIn(page);
    await openSyncCard(page, provider);

    await page.getByRole("button", { name: button }).click();

    // The whole sentence: the counts it already reported have to survive the one that was added.
    await expect(page.getByText(`Synced: 2 ${noun} linked to 1 tasks, 3 unlinked`)).toBeVisible();
  });

  /**
   * The branch that runs on every ordinary sync. Without the guard the toast would end ", 0
   * unlinked" every time, which is the noise the ternary exists to prevent — and nothing else in
   * the suite ever passes a zero.
   */
  test(`the ${provider} sync toast stays quiet when it took nothing away`, async ({ page }) => {
    await seedRepository(
      provider === "github"
        ? { repositoryUrl: "https://github.com/example/board", githubToken: "e2e-token-never-called" }
        : {
            repositoryUrl: "https://gitlab.com/example/board",
            gitlabToken: "e2e-token-never-called",
            gitlabHost: "https://gitlab.com",
          }
    );
    await stubSync(page, provider, 0);
    await signIn(page);
    await openSyncCard(page, provider);

    await page.getByRole("button", { name: button }).click();

    // Read once and whole, rather than asserting the absence of a substring: a retrying negative
    // on a toast outlives the toast and cannot fail.
    const toast = page.getByText(new RegExp(`^Synced: 2 ${noun} linked to 1 tasks$`));
    await expect(toast).toBeVisible();
  });
}
