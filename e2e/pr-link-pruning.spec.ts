import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { pruneContradictedLinks, removeProviderLinks, writeProviderLinks } from "@/lib/pr-links";
import { Task } from "@/models/task";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed, taskFactory } from "./seed";
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

const nothingIsElsewhere = () => false;

const prune = (over: Record<string, unknown> = {}) =>
  pruneContradictedLinks({
    projectId: String(PROJECT_ID),
    provider: "github",
    linkedThisRound: new Set<number>(),
    seenNumbers: new Set<number>(),
    namesAnotherRepository: nothingIsElsewhere,
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

test("a link left behind by a repository the project no longer points at is swept", async () => {
  const { _id } = await taskWith([
    link("github", 7010, "https://github.com/former/board/pull/7010"),
  ]);

  await prune({ namesAnotherRepository: (url: string) => url.includes("/former/") });

  expect(await linksOf(_id)).toEqual([]);
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
 * BP-559's rule, on this write too: the surviving array is computed from the document at write
 * time, so a sync of the other provider landing in the same moment is not dropped by a copy read
 * earlier.
 */
test("a GitLab sync landing mid-prune keeps what it wrote", async () => {
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
