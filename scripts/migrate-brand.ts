import { MongoClient, type Document } from "mongodb";
import { resolveUri, dbName } from "./mongo-uri";

const OLD = new RegExp(["cla", "ude", "( ?-? ?)", "plan", "ner"].join(""), "gi");

function rename(text: string): string {
  return text.replace(OLD, (match, sep: string) => {
    const head = match.slice(0, 5);
    if (head === head.toUpperCase()) return `BOARD${sep}PLANNER`;
    if (head[0] === head[0].toUpperCase()) return sep ? `Board${sep}Planner` : "Board Planner";
    return `board${sep}planner`;
  });
}

const OLD_HOST = /claude-planner-production\.up\.railway\.app/gi;
const NEW_HOST = "app.board-planner.com";

const PATH_LIKE = /^(\/|~\/|[A-Za-z]:\\)/;

const EXTERNAL_IDENTIFIER = /(^|\.)(githubRepo|gitlabRepo|repositoryUrl|redirectUri)$/;

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
    const after = rename(value.replace(OLD_HOST, NEW_HOST));
    if (after !== value) emit(path, value, after);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}.${i}`, includePaths, includeRepo, emit));
    return;
  }
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
  const includeRepo = args.includes("--include-repo");
  if (mode !== "scan" && mode !== "apply") {
    throw new Error(`Unknown mode "${mode}" — expected scan or apply`);
  }

  const { uri, source } = resolveUri();
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName());

  const collections = (await db.listCollections().toArray()).map((c) => c.name).sort();
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
