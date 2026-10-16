/**
 * BP-986: fill each project's `repositories` list from the repository it names today. Run once by
 * hand after the deploy that adds the field.
 *
 * Usage (a dry run is the default):
 *   MONGODB_URI=... npx tsx scripts/migrate-repositories.ts
 *   MONGODB_URI=... npx tsx scripts/migrate-repositories.ts --apply
 *
 * On an instance running GitHub Enterprise, pass `GITHUB_API_BASE_URL` too, as for
 * migrate-repository-url.ts: a legacy `githubRepo` names no host. Safe to re-run.
 */

import mongoose from "mongoose";
import { resolveUri, dbName } from "./mongo-uri";
import { migrateRepositories } from "../src/lib/repositories-migration";

const apply = process.argv.includes("--apply");

async function main() {
  const { uri, source } = resolveUri();
  await mongoose.connect(uri, { dbName: dbName(), autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle");
  console.log(`Database: ${db.databaseName} (from ${source}) ${apply ? "APPLYING" : "dry run"}`);
  const { filled, alreadyListed, noRepository, tooLong } = await migrateRepositories(db, { apply });
  for (const line of filled) console.log(`${line}${apply ? "" : " (dry run)"}`);
  console.log(`${filled.length} filled, ${alreadyListed} already listed, ${noRepository} name no repository`);
  for (const key of tooLong) console.log(`${key}: address longer than the list stores, left unlisted`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
