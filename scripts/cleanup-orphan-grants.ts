/**
 * BP-790: delete Grant rows whose board or account no longer exists. Deleting a project left its
 * grants behind until BP-790, and deleting a user did until BP-765.
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/cleanup-orphan-grants.ts            # reports, writes nothing
 *   MONGODB_URI=... npx tsx scripts/cleanup-orphan-grants.ts --apply
 *
 * Against production, through the database service:
 *   railway run --service MongoDB -- npx tsx scripts/cleanup-orphan-grants.ts
 */
import mongoose from "mongoose";
import { resolveUri, dbName } from "./mongo-uri";
import { findOrphanGrants, deleteOrphanGrants, type OrphanGrant } from "../src/lib/grants";

const APPLY = process.argv.includes("--apply");

function list(label: string, rows: OrphanGrant[]) {
  console.log(`${label}: ${rows.length}`);
  for (const g of rows) console.log(`  ${g._id}  ${g.relation} of project ${g.object} held by user ${g.subject}`);
}

async function main() {
  const { uri, source } = resolveUri();
  await mongoose.connect(uri, { autoIndex: false, ...(dbName() ? { dbName: dbName() } : {}) });
  console.log(`Connected via ${source} to database "${mongoose.connection.name}"${APPLY ? "" : " (dry run)"}`);

  const orphans = await findOrphanGrants();
  list("Grants on a deleted project", orphans.deletedProject);
  list("Grants held by a deleted user", orphans.deletedUser);

  if (!APPLY) {
    console.log("\nNothing deleted. Re-run with --apply to delete them.");
  } else {
    const deleted = await deleteOrphanGrants(orphans);
    console.log(`\nDeleted ${deleted} grant(s).`);
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
