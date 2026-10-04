/**
 * BP-896: the stored field and collection take the name the product uses. Run by hand, in order:
 *
 *   1. before the deploy:  MONGODB_URI=... npx tsx scripts/adopt-organisation-field.ts --apply
 *   2. after the deploy:   the same command again, for anything the old release wrote in between
 *   3. then:               MONGODB_URI=... npx tsx scripts/adopt-organisation-field.ts --finalise --apply
 *
 * Without --apply each step only reports. Step 3 refuses while anything is left uncopied.
 * Snapshot first: `dump-collections.ts dump ./backups all`.
 */

import mongoose from "mongoose";
import { resolveUri, dbName } from "./mongo-uri";
import { copyLegacyField, finaliseLegacyField } from "../src/lib/organisation-field-migration";

const apply = process.argv.includes("--apply");
const finalise = process.argv.includes("--finalise");

async function main() {
  const { uri, source } = resolveUri();
  await mongoose.connect(uri, { dbName: dbName(), autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle");
  console.log(`Database: ${db.databaseName} (from ${source}) ${apply ? "APPLYING" : "dry run"} ${finalise ? "finalise" : "copy"}`);
  if (!(await db.listCollections().toArray()).length) {
    throw new Error(`No collections in "${db.databaseName}" — wrong database? Set MONGODB_DB.`);
  }

  const report = finalise ? await finaliseLegacyField(mongoose.connection, { apply }) : await copyLegacyField(mongoose.connection, { apply });
  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
