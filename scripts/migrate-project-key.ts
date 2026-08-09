/**
 * Change a project's key, and keep everything that referred to it working.
 *
 *   npx tsx scripts/migrate-project-key.ts CP BP           # reports, writes nothing
 *   npx tsx scripts/migrate-project-key.ts CP BP --apply
 *
 * A task key is never stored — it is built as `${project.key}-${taskNumber}` wherever one
 * is shown. So this single field renames all of a project's tasks at once, and everything
 * that quoted the old key stays behind:
 *
 *   - Pull requests and branches on GitHub keep their `cp-…` prefix forever. The old key
 *     is appended to `formerKeys`, which is what matchPRsToTasks reads so those keep
 *     linking. Losing that is silent: the sync simply matches less than it used to.
 *   - Prose that says "CP-250" is rewritten to "BP-250", because it is pointing at a task
 *     that now answers to the new name.
 *   - Prose that says "cp-250/slug" is a **branch name** and is left alone — that branch
 *     still exists under exactly that name.
 */

import { MongoClient } from "mongodb";
import { resolveUri, dbName } from "./mongo-uri";

interface Rewrite {
  collection: string;
  id: unknown;
  path: string;
  before: string;
  after: string;
}

function referenceRewriter(from: string, to: string) {
  // Uppercase and not followed by a slash: a task reference. The lowercase, slash-suffixed
  // form is how every branch in this repository is named, and those are not ours to rename.
  const reference = new RegExp(`\\b${from}-(\\d+)\\b(?!/)`, "g");

  // A placeholder rather than a number — "cp-<n>/<slug>" is documentation of the branch
  // convention, and the convention follows the key. "cp-213/generic-field-activity" is a
  // branch that exists under exactly that name and stays.
  const convention = new RegExp(`\\b${from}(-<(?:n|number)>)`, "gi");

  return (text: string) =>
    text
      .replace(reference, `${to}-$1`)
      .replace(convention, (_m, tail: string) => `${to.toLowerCase()}${tail}`);
}

function walk(value: unknown, path: string, rewrite: (t: string) => string,
              emit: (path: string, before: string, after: string) => void): void {
  if (typeof value === "string") {
    const after = rewrite(value);
    if (after !== value) emit(path, value, after);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}.${i}`, rewrite, emit));
    return;
  }
  if (value && typeof value === "object" && value.constructor === Object) {
    for (const [key, child] of Object.entries(value)) {
      walk(child, path ? `${path}.${key}` : key, rewrite, emit);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const [from, to] = args.filter((a) => !a.startsWith("--")).map((a) => a.toUpperCase());
  const apply = args.includes("--apply");
  if (!from || !to) throw new Error("Usage: migrate-project-key.ts <FROM> <TO> [--apply]");
  if (from === to) throw new Error("The two keys are the same");

  const { uri, source } = resolveUri();
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName());

  console.log(`connection : ${source}`);
  console.log(`database   : ${db.databaseName}`);

  // Accept a project that has already moved to the new key: the key write and the text
  // repointing are separate passes, and text can be left behind by an earlier run
  let project = await db.collection("projects").findOne({ key: from });
  const alreadyMoved = !project;
  if (!project) project = await db.collection("projects").findOne({ key: to, formerKeys: from });
  if (!project) {
    const keys = (await db.collection("projects").find({}, { projection: { key: 1 } }).toArray())
      .map((p) => p.key)
      .join(", ");
    throw new Error(
      `No project has key "${from}", and none has "${to}" with "${from}" among its former keys. ` +
        `This database holds: ${keys || "no projects"}`
    );
  }
  if (alreadyMoved) console.log(`note       : key is already ${to} — repointing leftover text only`);

  const taskCount = await db.collection("tasks").countDocuments({ project: project._id });
  console.log(`project    : ${project.name} (${from} → ${to}), ${taskCount} task(s) renamed with it`);
  console.log(`formerKeys : ${[...(project.formerKeys ?? []), from].join(", ")}\n`);

  const rewrite = referenceRewriter(from, to);
  const rewrites: Rewrite[] = [];
  for (const name of (await db.listCollections().toArray()).map((c) => c.name).sort()) {
    for (const doc of await db.collection(name).find({}).toArray()) {
      walk(doc, "", rewrite, (path, before, after) => {
        rewrites.push({ collection: name, id: doc._id, path, before, after });
      });
    }
  }

  if (rewrites.length) {
    const byField = new Map<string, number>();
    for (const r of rewrites) {
      const key = `${r.collection}.${r.path.replace(/\.\d+(?=\.|$)/g, "[]")}`;
      byField.set(key, (byField.get(key) ?? 0) + 1);
    }
    console.log(`${rewrites.length} textual reference(s) to ${from}-<n> to repoint:\n`);
    for (const [field, count] of [...byField].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}  ${field}`);
    }
    console.log(`\n  e.g. ${rewrites[0].before.slice(0, 90)}`);
    console.log(`    →  ${rewrites[0].after.slice(0, 90)}`);
  } else {
    console.log("No textual references to repoint.");
  }

  if (!apply) {
    console.log(`\nNothing was written. Re-run with --apply.`);
    await client.close();
    return;
  }

  // The key and its history move together: a key changed without its predecessor recorded
  // is the one state from which the pull-request links cannot be recovered
  if (!alreadyMoved) {
    await db.collection("projects").updateOne(
      { _id: project._id },
      { $set: { key: to }, $addToSet: { formerKeys: from } }
    );
  }

  const perDoc = new Map<string, { collection: string; id: unknown; sets: Record<string, string> }>();
  for (const r of rewrites) {
    const k = `${r.collection}:${String(r.id)}`;
    const entry = perDoc.get(k) ?? { collection: r.collection, id: r.id, sets: {} };
    entry.sets[r.path] = r.after;
    perDoc.set(k, entry);
  }
  let written = 0;
  for (const { collection, id, sets } of perDoc.values()) {
    const res = await db.collection(collection).updateOne({ _id: id as never }, { $set: sets });
    written += res.modifiedCount;
  }

  const check = await db.collection("projects").findOne({ _id: project._id }, { projection: { key: 1, formerKeys: 1 } });
  console.log(`\nKey is now ${check?.key}, former keys ${JSON.stringify(check?.formerKeys)}.`);
  console.log(`Repointed ${written} document(s).`);
  await client.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
