/**
 * BP-876: give every activity row written before it the project of its task. Safe to re-run.
 *
 * Usage (a dry run is the default):
 *   MONGODB_URI=... npx tsx scripts/backfill-activity-project.ts
 *   MONGODB_URI=... npx tsx scripts/backfill-activity-project.ts --apply
 *
 * Deploy the release that writes `project` first, then run this; a row written between the two is
 * simply not in its way. Snapshot first: `dump-collections.ts dump ./backups all`.
 */

import mongoose from "mongoose";
import { resolveUri, dbName } from "./mongo-uri";
import { backfillActivityProjects } from "../src/lib/activity-project-backfill";

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

  const report = await backfillActivityProjects(db, { apply });
  console.log(JSON.stringify(report, null, 2));
  console.log(
    apply
      ? `Done: ${report.rowsFilled} rows given a project; ${report.orphanedRows} rows belong to ${report.orphanedTasks} deleted tasks and were left.`
      : `Dry run: ${report.rowsFilled} rows would be given a project; ${report.orphanedRows} rows belong to ${report.orphanedTasks} deleted tasks.`
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
