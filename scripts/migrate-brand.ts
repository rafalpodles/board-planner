/**
 * Rewrite the old product name in stored data, after the code was renamed.
 *
 *   npx tsx scripts/migrate-brand.ts scan            # default: changes nothing
 *   npx tsx scripts/migrate-brand.ts apply
 *
 * Against production, from a laptop — the app service's URI is on Railway's private
 * network, so go through the database service, and take the snapshot first:
 *
 *   railway run --service MongoDB -- sh -c 'MONGODB_URI="$MONGO_PUBLIC_URL" \
 *     npx tsx scripts/dump-collections.ts dump ./backups \
 *     projects,tasks,comments,workers,notifications,pmmessages,activitylogs'
 *   railway run --service MongoDB -- sh -c 'MONGODB_URI="$MONGO_PUBLIC_URL" npx tsx scripts/migrate-brand.ts scan'
 *   railway run --service MongoDB -- sh -c 'MONGODB_URI="$MONGO_PUBLIC_URL" npx tsx scripts/migrate-brand.ts apply'
 *
 * Production's database is literally named `test`, so it cannot be recognised by name —
 * read the document count this prints before trusting any verdict. Restoring is
 * `dump-collections.ts restore ./backups/<dir>`, which replaces those collections
 * wholesale and therefore also undoes anything written since the dump.
 *
 * Every collection and every string field is walked, rather than a list of fields
 * written up front: the development database carries almost none of this content, so
 * a hand-written list would have been drawn from the wrong sample and would miss
 * whatever production actually holds.
 *
 * Filesystem paths are left alone by default — see PATH_LIKE. A worker's repository
 * allowlist stores the absolute path of a checkout, and rewriting it while the
 * directory on disk still has its old name unbinds every repository that worker owns.
 * Pass --include-paths once the directory has actually been renamed.
 */

import { MongoClient, type Document } from "mongodb";
import { resolveUri, dbName } from "./mongo-uri";

const OLD = new RegExp(["cla", "ude", "( ?-? ?)", "plan", "ner"].join(""), "gi");

/**
 * Case and separator of the match decide the replacement, so identifiers stay identifiers
 * and prose stays prose. The closed-up capitalised form is the one that matters: it is
 * almost always prose a person or the PM agent reads, and it takes the space back.
 */
function rename(text: string): string {
  return text.replace(OLD, (match, sep: string) => {
    const head = match.slice(0, 5);
    if (head === head.toUpperCase()) return `BOARD${sep}PLANNER`;
    if (head[0] === head[0].toUpperCase()) return sep ? `Board${sep}Planner` : "Board Planner";
    return `board${sep}planner`;
  });
}

/** The old deployment, which outlived the rename and still answers. */
const OLD_HOST = /claude-planner-production\.up\.railway\.app/gi;
const NEW_HOST = "app.board-planner.com";

/** A value that is a path on somebody's disk, not prose about the product. */
const PATH_LIKE = /^(\/|~\/|[A-Za-z]:\\)/;

/**
 * Fields naming something that lives outside this database and did not get renamed with it.
 * A repository is the sharpest case: the project points at `rafalpodles/claude-planner`,
 * that is still the repository's name on GitHub, and rewriting it makes every pull-request
 * sync ask about a repository that does not exist. A redirect URI is registered with the
 * remote OAuth server, so changing this copy only makes the two disagree.
 */
const EXTERNAL_IDENTIFIER = /(^|\.)(githubRepo|gitlabRepo|repositoryUrl|redirectUri)$/;

/** The subset of those that a repository rename does make stale. */
const REPOSITORY_FIELD = /(^|\.)(githubRepo|gitlabRepo|repositoryUrl)$/;

interface Change {
  collection: string;
  id: unknown;
  path: string;
  before: string;
  after: string;
}

function walk(
  value: unknown,
  path: string,
  includePaths: boolean,
  includeRepo: boolean,
  emit: (path: string, before: string, after: string) => void
): void {
  if (typeof value === "string") {
    const external = EXTERNAL_IDENTIFIER.test(path);
    const repoField = REPOSITORY_FIELD.test(path);
    if (external && !(repoField && includeRepo)) return;
    if (!includePaths && PATH_LIKE.test(value)) return;
    // Host first: the generic rename would turn "claude-planner-production…" into
    // "board-planner-production…", a hostname that resolves to nothing, and the host
    // pattern would no longer match to correct it
    const after = rename(value.replace(OLD_HOST, NEW_HOST));
    if (after !== value) emit(path, value, after);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}.${i}`, includePaths, includeRepo, emit));
    return;
  }
  // Only plain objects: an ObjectId or a Date has no strings of ours inside it, and
  // descending into one would produce a path that $set cannot address
  if (value && typeof value === "object" && value.constructor === Object) {
    for (const [key, child] of Object.entries(value)) {
      walk(child, path ? `${path}.${key}` : key, includePaths, includeRepo, emit);
    }
  }
}

function preview(text: string): string {
  const at = text.search(OLD) >= 0 ? text.search(OLD) : 0;
  const from = Math.max(0, at - 30);
  return (from ? "…" : "") + text.slice(from, at + 60).replace(/\s+/g, " ") + (text.length > at + 60 ? "…" : "");
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.find((a) => !a.startsWith("--")) ?? "scan";
  const includePaths = args.includes("--include-paths");
  // The repository fields are excluded because they name a repository that did not get
  // renamed with the product. Once it has been, this is how they catch up.
  const includeRepo = args.includes("--include-repo");
  if (mode !== "scan" && mode !== "apply") {
    throw new Error(`Unknown mode "${mode}" — expected scan or apply`);
  }

  const { uri, source } = resolveUri();
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName());

  const collections = (await db.listCollections().toArray()).map((c) => c.name).sort();
  // Printed before any verdict: an empty database and a finished migration both report
  // "nothing to change", and only the row counts tell them apart
  console.log(`connection : ${source}`);
  console.log(`database   : ${db.databaseName}`);
  console.log(`collections: ${collections.length}`);
  if (!collections.length) {
    throw new Error("This database has no collections — refusing to report a clean scan against an empty database");
  }

  const changes: Change[] = [];
  let scanned = 0;

  for (const name of collections) {
    for (const doc of await db.collection(name).find({}).toArray()) {
      scanned++;
      walk(doc, "", includePaths, includeRepo, (path, before, after) => {
        changes.push({ collection: name, id: doc._id, path, before, after });
      });
    }
  }

  console.log(`documents  : ${scanned}\n`);

  if (!changes.length) {
    console.log("Nothing left to rename.");
    await client.close();
    return;
  }

  const byField = new Map<string, Change[]>();
  for (const c of changes) {
    // Array indices collapse so a report reads "checklist[].text", not one line per item
    const key = `${c.collection}.${c.path.replace(/\.\d+(?=\.|$)/g, "[]")}`;
    (byField.get(key) ?? byField.set(key, []).get(key)!).push(c);
  }

  console.log(`${changes.length} value(s) to rewrite across ${byField.size} field(s):\n`);
  for (const [field, list] of [...byField].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(list.length).padStart(4)}  ${field}`);
    console.log(`        e.g. ${preview(list[0].before)}`);
  }

  if (mode === "scan") {
    console.log(`\nScan only — nothing was written. Re-run with "apply" to make these changes.`);
    if (!includePaths) {
      console.log(`Filesystem paths were skipped; pass --include-paths once the checkout directory is renamed.`);
    }
    if (!includeRepo) {
      console.log(`Repository fields were skipped — pass --include-repo once the repository itself is renamed.`);
    }
    console.log(`OAuth redirect fields were skipped — those are registered on the other side.`);
    await client.close();
    return;
  }

  // Grouped per document so each one takes a single round trip, and so a document
  // with several changed fields can never be left half-rewritten
  const perDoc = new Map<string, { collection: string; id: unknown; sets: Record<string, string> }>();
  for (const c of changes) {
    const key = `${c.collection}:${String(c.id)}`;
    const entry = perDoc.get(key) ?? { collection: c.collection, id: c.id, sets: {} };
    entry.sets[c.path] = c.after;
    perDoc.set(key, entry);
  }

  let written = 0;
  for (const { collection, id, sets } of perDoc.values()) {
    const res = await db.collection(collection).updateOne({ _id: id as never }, { $set: sets });
    written += res.modifiedCount;
  }

  console.log(`\nRewrote ${written} document(s).`);
  console.log(`Re-run "scan" to confirm it reports nothing left — this migration is idempotent.`);
  await client.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
