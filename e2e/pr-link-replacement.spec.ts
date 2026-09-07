import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { replaceProviderLinks } from "@/lib/pr-links";
import { E2E_MONGODB_URI, PROJECT_ID } from "./seed";

/**
 * BP-559. Both sync routes replace their own provider's links with an aggregation pipeline instead
 * of a read-mutate-save, so an overlapping sync of the other provider cannot be silently dropped.
 *
 * A unit test can only assert the pipeline's *shape*, which says nothing about what MongoDB does
 * with it — `$$this` inside `$filter`, `$ifNull` against a missing field and the un-cast dates are
 * exactly the parts a shape assertion agrees with while they are wrong. So this runs the real
 * update against the real database.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

let nextNumber = 9300;

function link(provider: "github" | "gitlab" | null, number: number) {
  const doc: Record<string, unknown> = {
    number,
    title: `PR ${number}`,
    state: "open",
    url: `https://example.test/${number}`,
    mergedAt: null,
    updatedAt: new Date("2026-08-01T00:00:00Z"),
  };
  if (provider) doc.provider = provider;
  return doc;
}

async function taskWith(linkedPRs: Record<string, unknown>[] | undefined) {
  const handle = await db();
  const _id = new mongoose.Types.ObjectId();
  const doc: Record<string, unknown> = {
    _id,
    title: "PR link replacement",
    project: new mongoose.Types.ObjectId(PROJECT_ID),
    taskNumber: nextNumber++,
    status: "todo",
    priority: "medium",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  // `undefined` means the field is absent, which is the state every task created before the
  // provider work is in — `$ifNull` is the only reason the pipeline survives it.
  if (linkedPRs) doc.linkedPRs = linkedPRs;
  await handle.collection("tasks").insertOne(doc);
  return _id;
}

async function apply(_id: mongoose.Types.ObjectId, provider: "github" | "gitlab", docs: unknown[]) {
  const handle = await db();
  await handle.collection("tasks").updateOne({ _id }, replaceProviderLinks(provider, docs));
}

async function linksOf(_id: mongoose.Types.ObjectId) {
  const handle = await db();
  const found = await handle.collection("tasks").findOne({ _id });
  return (found?.linkedPRs ?? []) as Record<string, unknown>[];
}

test.afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("a GitLab sync replaces only GitLab's links", async () => {
  const _id = await taskWith([link("github", 1), link("gitlab", 2)]);

  await apply(_id, "gitlab", [link("gitlab", 3)]);

  const links = await linksOf(_id);
  expect(links.map((l) => [l.provider, l.number])).toEqual([
    ["github", 1],
    ["gitlab", 3],
  ]);
});

test("a link stored before the provider field existed belongs to GitHub", async () => {
  const legacy = await taskWith([link(null, 4)]);
  await apply(legacy, "gitlab", [link("gitlab", 5)]);
  // GitLab must not adopt it: an unmarked link is GitHub's, so it survives a GitLab sync…
  expect((await linksOf(legacy)).map((l) => l.number)).toEqual([4, 5]);

  const replaced = await taskWith([link(null, 4)]);
  await apply(replaced, "github", [link("github", 6)]);
  // …and is replaced by a GitHub one rather than left beside it, which is what a duplicated card
  // in the task panel looked like before the provider field existed.
  expect((await linksOf(replaced)).map((l) => l.number)).toEqual([6]);
});

test("a task that has never been synced takes its first links", async () => {
  const _id = await taskWith(undefined);

  await apply(_id, "github", [link("github", 7)]);

  expect((await linksOf(_id)).map((l) => l.number)).toEqual([7]);
});

test("two providers syncing at once keep both sets of links", async () => {
  const _id = await taskWith([]);

  await Promise.all([
    apply(_id, "github", [link("github", 8)]),
    apply(_id, "gitlab", [link("gitlab", 9)]),
  ]);

  const links = await linksOf(_id);
  expect(links.map((l) => l.number).sort()).toEqual([8, 9]);
});

test("dates reach the database as dates, not as strings", async () => {
  const _id = await taskWith([]);

  await apply(_id, "github", [link("github", 10)]);

  // Mongoose casts a `$set` object against the schema and a pipeline not at all, so the routes
  // build these by hand; a string here sorts and compares as text everywhere downstream.
  expect((await linksOf(_id))[0].updatedAt).toBeInstanceOf(Date);
});
