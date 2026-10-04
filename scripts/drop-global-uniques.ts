/**
 * BP-665: drop the seven global unique indexes that per-tenant twins replaced. Run once by hand,
 * after a deploy of the app has built the twins.
 *
 * Usage (a dry run is the default):
 *   MONGODB_URI=... npx tsx scripts/drop-global-uniques.ts
 *   MONGODB_URI=... npx tsx scripts/drop-global-uniques.ts --apply
 *
 * Refuses an index whose per-tenant twin is missing. Safe to re-run.
 */

import mongoose from "mongoose";
import { resolveUri, dbName } from "./mongo-uri";
import { dropGlobalUniques } from "../src/lib/tenant-migration";

const apply = process.argv.includes("--apply");

async function main() {
  const { uri, source } = resolveUri();
  await mongoose.connect(uri, { dbName: dbName(), autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle");
  console.log(`Database: ${db.databaseName} (from ${source}) ${apply ? "APPLYING" : "dry run"}`);
  if (!(await db.listCollections().toArray()).length) {
    throw new Error(`No collections in "${db.databaseName}" — wrong database? Set MONGODB_DB.`);
  }
  for (const { collection, name, state } of await dropGlobalUniques(mongoose.connection, { apply })) {
    console.log(`${collection}.${name}: ${state}`);
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
