/**
 * Snapshot collections to disk before a migration, and put them back if needed.
 *
 *   MONGODB_URI=... npx tsx scripts/dump-collections.ts dump ./backups
 *   MONGODB_URI=... npx tsx scripts/dump-collections.ts verify ./backups/<dir>
 *   MONGODB_URI=... npx tsx scripts/dump-collections.ts restore ./backups/<dir>
 *
 * Defaults to `projects` and `tasks` — everything CP-213's migration can touch.
 * Pass a comma-separated list as the third argument for anything else.
 *
 * `restore` replaces the listed collections wholesale with the snapshot, so it also
 * undoes anything else written since the dump. Run `verify` first to see the drift.
 */

import { MongoClient, type Document } from "mongodb";
import { EJSON } from "bson";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_COLLECTIONS = ["projects", "tasks"];

/**
 * Extended JSON, not JSON.stringify: the latter turns an ObjectId into a plain
 * string, so a restore would give every document a string `_id` and every task a
 * string `project` — orphaning it from its project while looking like it worked.
 */
const encode = (docs: Document[]) => EJSON.stringify(docs, undefined, 1, { relaxed: false });
const decode = (raw: string) => EJSON.parse(raw, { relaxed: false }) as Document[];

function readDump(dir: string): { name: string; docs: Document[] }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((file) => ({ name: file.replace(/\.json$/, ""), docs: decode(readFileSync(join(dir, file), "utf8")) }));
}

async function dump(db: ReturnType<MongoClient["db"]>, target: string, collections: string[]) {
  // The timestamp comes from the caller's clock, so two runs a second apart
  // cannot land in the same directory
  const dir = join(target, new Date().toISOString().replace(/[:.]/g, "-"));

  // Everything is read and checked before anything is written, so a rejected dump
  // leaves no half-written directory that could later be mistaken for a backup
  const encoded = new Map<string, string>();
  let total = 0;

  for (const name of collections) {
    const docs = await db.collection(name).find({}).toArray();
    const json = encode(docs);

    // A dump that cannot be read back is worthless, and the failure would only
    // surface during the restore — the one moment there is nothing to fall back on
    const roundTripped = decode(json);
    if (roundTripped.length !== docs.length) throw new Error(`${name}: dump does not read back`);
    for (const [i, doc] of roundTripped.entries()) {
      if (String(doc._id) !== String(docs[i]._id) || doc._id?.constructor !== docs[i]._id?.constructor) {
        throw new Error(`${name}: _id does not survive the round trip — refusing to write a dump that cannot restore`);
      }
    }

    encoded.set(name, json);
    console.log(`  ${name}: ${docs.length} documents`);
    total += docs.length;
  }

  // Connecting to the wrong database succeeds and dumps nothing, which reads as a
  // clean backup right up until the restore that was supposed to save you
  if (!total) {
    throw new Error(
      `Every collection is empty — this is almost certainly the wrong database. ` +
        `Set MONGODB_DB to name the right one.`
    );
  }

  mkdirSync(dir, { recursive: true });
  for (const [name, json] of encoded) writeFileSync(join(dir, `${name}.json`), json);

  console.log(`\nWritten to ${dir}`);
  console.log(`Verify it:  MONGODB_URI=... npx tsx scripts/dump-collections.ts verify ${dir}`);
}

async function verify(db: ReturnType<MongoClient["db"]>, target: string) {
  let drift = 0;
  for (const { name, docs } of readDump(target)) {
    const live = await db.collection(name).find({}).toArray();
    const liveById = new Map(live.map((d) => [String(d._id), encode([d])]));

    // Counts alone would call a database "unchanged" after an in-place update of
    // every document, which is exactly what the migration does
    const changed = docs.filter((d) => liveById.get(String(d._id)) !== encode([d])).length;
    const missing = docs.filter((d) => !liveById.has(String(d._id))).length;
    const added = live.length - (docs.length - missing);
    drift += changed + missing + added;

    console.log(
      `  ${name}: ${docs.length} in dump, ${live.length} live` +
        (changed || missing || added
          ? ` — ${changed} changed, ${missing} gone, ${added} new`
          : " ✓ identical")
    );
  }
  console.log(drift ? "\nThe database has moved on from this dump." : "\nDump matches the database exactly.");
}

async function restore(db: ReturnType<MongoClient["db"]>, target: string) {
  for (const { name, docs } of readDump(target)) {
    if (!docs.length) {
      console.log(`  ${name}: dump is empty, skipping rather than wiping the collection`);
      continue;
    }
    await db.collection(name).deleteMany({});
    await db.collection(name).insertMany(docs);
    console.log(`  ${name}: restored ${docs.length} documents`);
  }
  console.log("\nRestored. Restart the app — Mongoose caches compiled models.");
}

/**
 * Railway names this differently per service: the app gets MONGODB_URI pointing at
 * the private network, the database service gets MONGO_PUBLIC_URL for the outside.
 * Anything on `.railway.internal` only resolves inside Railway, so prefer a public
 * candidate over one we know cannot connect from here.
 */
const URI_VARS = ["MONGODB_URI", "MONGO_PUBLIC_URL", "MONGO_URL", "DATABASE_URL"];

function resolveUri(): { uri: string; source: string } {
  const found = URI_VARS.filter((name) => process.env[name]).map((name) => ({
    source: name,
    uri: process.env[name] as string,
  }));
  if (!found.length) throw new Error(`Set one of: ${URI_VARS.join(", ")}`);

  const reachable = found.filter((c) => !c.uri.includes(".railway.internal"));
  if (!reachable.length) {
    throw new Error(
      `${found.map((c) => c.source).join(", ")} point at Railway's private network ` +
        `(.railway.internal), which only resolves from inside Railway.\n` +
        `Run against the database service instead, which exposes a public address:\n` +
        `  railway run --service MongoDB -- npx tsx scripts/dump-collections.ts ...`
    );
  }
  return reachable[0];
}

async function main() {
  const [mode, target, collectionArg] = process.argv.slice(2);
  if (!mode || !["dump", "verify", "restore"].includes(mode)) {
    throw new Error("Usage: dump <dir> | verify <dir> | restore <dir>");
  }
  if (!target) throw new Error("A directory is required");

  const { uri, source } = resolveUri();
  const client = await MongoClient.connect(uri);
  // A public database URL often carries no database in its path, and the driver
  // then quietly hands back `test` — dumping an empty database that is not the one
  // being migrated. MONGODB_DB forces it.
  const db = client.db(process.env.MONGODB_DB || undefined);
  console.log(`Database: ${db.databaseName} (from ${source})`);

  if (mode === "dump") await dump(db, target, (collectionArg || DEFAULT_COLLECTIONS.join(",")).split(","));
  if (mode === "verify") await verify(db, target);
  if (mode === "restore") await restore(db, target);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
