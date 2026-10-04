/**
 * BP-662: put an existing instance into one named organisation. Run once by hand.
 *
 * Usage (a dry run is the default):
 *   MONGODB_URI=... npx tsx scripts/migrate-organisation.ts --name "Rafał-org"
 *   MONGODB_URI=... npx tsx scripts/migrate-organisation.ts --name "Rafał-org" --apply
 *
 * The organisation is the instance's existing Organisation row (entitlements kept), re-keyed to the
 * default organisation id and named; every document without an organisation is then given it. Safe to re-run.
 * Snapshot first: `dump-collections.ts dump ./backups all`.
 */

import mongoose from "mongoose";
import { resolveUri, dbName } from "./mongo-uri";
import { backfillOrganisations, ensureOrganisation } from "../src/lib/organisation-migration";

const apply = process.argv.includes("--apply");
const nameArg = process.argv.indexOf("--name");
const name = nameArg > -1 ? process.argv[nameArg + 1]?.trim() : undefined;

async function main() {
  if (!name || name.startsWith("--")) throw new Error('--name "<organisation>" is required');
  const { uri, source } = resolveUri();
  await mongoose.connect(uri, { dbName: dbName(), autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle");
  console.log(`Database: ${db.databaseName} (from ${source}) ${apply ? "APPLYING" : "dry run"}`);

  const collections = await db.listCollections().toArray();
  if (!collections.length) {
    throw new Error(`No collections in "${db.databaseName}" — wrong database? Set MONGODB_DB.`);
  }

  console.log(`Organisation "${name}": ${await ensureOrganisation(mongoose.connection, { apply, name })}`);
  const { total, byCollection } = await backfillOrganisations(mongoose.connection, { apply });
  console.log(JSON.stringify(byCollection, null, 2));
  console.log(apply ? `Done: ${total} documents given an organisation.` : `Dry run: ${total} documents would be given an organisation.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
