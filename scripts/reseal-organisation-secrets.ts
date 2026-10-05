/**
 * BP-898: reseals every secret still under the instance key with its organisation's own key.
 * Run after the deploy that reads both, with the ENCRYPTION_KEY (and ENCRYPTION_KEYS_OLD) the app runs with.
 *
 *   MONGODB_URI=... ENCRYPTION_KEY=... npx tsx scripts/reseal-organisation-secrets.ts            # dry run
 *   MONGODB_URI=... ENCRYPTION_KEY=... npx tsx scripts/reseal-organisation-secrets.ts --apply
 *
 * Safe to re-run: done when a dry run reports 0 and nothing to act on.
 */

import mongoose from "mongoose";
import { resolveUri, dbName } from "./mongo-uri";
import { resealUnderOrganisationKeys } from "../src/lib/organisation-secrets-migration";

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
  const report = await resealUnderOrganisationKeys(mongoose.connection, { apply });
  console.log(JSON.stringify(report.byCollection, null, 2));
  console.log(`${apply ? "Resealed" : "Would reseal"} ${report.resealed} secret(s).`);
  if (report.needsAttention.length) console.log(`Act on these:\n${report.needsAttention.map((line) => `  ${line}`).join("\n")}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
