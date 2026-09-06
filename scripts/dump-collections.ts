import { MongoClient, type Document } from "mongodb";
import { EJSON } from "bson";
import { resolveUri, dbName } from "./mongo-uri";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_COLLECTIONS = ["projects", "tasks"];

const encode = (docs: Document[]) => EJSON.stringify(docs, undefined, 1, { relaxed: false });
const decode = (raw: string) => EJSON.parse(raw, { relaxed: false }) as Document[];

function readDump(dir: string): { name: string; docs: Document[] }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((file) => ({ name: file.replace(/\.json$/, ""), docs: decode(readFileSync(join(dir, file), "utf8")) }));
}

async function dump(db: ReturnType<MongoClient["db"]>, target: string, collections: string[]) {
  const dir = join(target, new Date().toISOString().replace(/[:.]/g, "-"));

  const encoded = new Map<string, string>();
  let total = 0;

  for (const name of collections) {
    const docs = await db.collection(name).find({}).toArray();
    const json = encode(docs);

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

async function main() {
  const [mode, target, collectionArg] = process.argv.slice(2);
  if (!mode || !["dump", "verify", "restore"].includes(mode)) {
    throw new Error("Usage: dump <dir> | verify <dir> | restore <dir>");
  }
  if (!target) throw new Error("A directory is required");

  const { uri, source } = resolveUri();
  const client = await MongoClient.connect(uri);
  const db = client.db(dbName());
  console.log(`Database: ${db.databaseName} (from ${source})`);

  if (mode === "dump") {
    const requested =
      collectionArg === "all"
        ? (await db.listCollections().toArray()).map((c) => c.name).sort()
        : (collectionArg || DEFAULT_COLLECTIONS.join(",")).split(",");
    console.log(`Collections: ${requested.length} (${requested.join(", ")})`);
    await dump(db, target, requested);
  }
  if (mode === "verify") await verify(db, target);
  if (mode === "restore") await restore(db, target);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
