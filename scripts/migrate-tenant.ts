/**
 * BP-662: give every document the default tenant (the app also does it once at start-up).
 *
 * Usage (a dry run is the default):
 *   MONGODB_URI=... npx tsx scripts/migrate-tenant.ts
 *   MONGODB_URI=... npx tsx scripts/migrate-tenant.ts --apply
 *
 * Safe to re-run. Snapshot first: `dump-collections.ts dump ./backups all`.
 */

import mongoose from "mongoose";
import { resolveUri, dbName } from "./mongo-uri";
import { backfillTenants } from "../src/lib/tenant-migration";

const apply = process.argv.includes("--apply");

async function main() {
  const { uri, source } = resolveUri();
  await mongoose.connect(uri, { dbName: dbName(), autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle");
  console.log(`Database: ${db.databaseName} (from ${source}) ${apply ? "APPLYING" : "dry run"}`);

  const collections = await db.listCollections().toArray();
  if (!collections.length) {
    throw new Error(`No collections in "${db.databaseName}" — wrong database? Set MONGODB_DB.`);
  }

  const report = await backfillTenants(mongoose.connection, { apply });
  console.log(JSON.stringify(report, null, 2));
  const pending = Object.values(report.withoutTenant).reduce((a, b) => a + b, 0);
  console.log(apply ? `Done: ${pending} documents given a tenant.` : `Dry run: ${pending} documents would be given a tenant.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
