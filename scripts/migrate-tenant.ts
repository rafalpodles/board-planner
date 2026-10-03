/**
 * BP-662: put every document under the default tenant and replace the global uniques with
 * per-tenant ones.
 *
 * Usage (a dry run is the default):
 *   MONGODB_URI=... npx tsx scripts/migrate-tenant.ts
 *   MONGODB_URI=... npx tsx scripts/migrate-tenant.ts --apply --snapshot-dir ./backups/<dir>
 *
 * `--apply` refuses without a snapshot taken with `dump-collections.ts dump ./backups all`: the
 * directory must hold a file for every collection in the database, since a dump that misses one
 * reads as a safety net and is not.
 *
 * Safe to re-run: documents that have a tenant are left alone, an index that is already replaced
 * is not touched, and a second run reports zero changes.
 */

import mongoose from "mongoose";
import { resolveUri, dbName } from "./mongo-uri";
import { collectionsMissingFromSnapshot, migrateToTenants } from "../src/lib/tenant-migration";

const apply = process.argv.includes("--apply");
const snapshotArg = process.argv.indexOf("--snapshot-dir");
const snapshotDir = snapshotArg > -1 ? process.argv[snapshotArg + 1] : undefined;

async function main() {
  const { uri, source } = resolveUri();
  await mongoose.connect(uri, { dbName: dbName(), autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle");
  console.log(`Database: ${db.databaseName} (from ${source}) ${apply ? "APPLYING" : "dry run"}`);

  const collections = (await db.listCollections().toArray()).map((c) => c.name).filter((n) => !n.startsWith("system."));
  if (!collections.length) {
    throw new Error(`No collections in "${db.databaseName}" — wrong database? Set MONGODB_DB.`);
  }

  if (apply) {
    if (!snapshotDir) throw new Error("--apply needs --snapshot-dir <dir> from dump-collections.ts dump <target> all");
    const missing = collectionsMissingFromSnapshot(snapshotDir, collections);
    if (missing.length) {
      throw new Error(`The snapshot at ${snapshotDir} has no file for: ${missing.join(", ")}`);
    }
  }

  const report = await migrateToTenants(mongoose.connection, { apply });
  console.log(JSON.stringify(report, null, 2));
  const pending = Object.values(report.withoutTenant).reduce((a, b) => a + b, 0);
  console.log(
    apply
      ? `Done: ${pending} documents given a tenant, ${report.indexesDropped.length} old indexes dropped.`
      : `Dry run: ${pending} documents would be given a tenant. Nothing was written.`
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
