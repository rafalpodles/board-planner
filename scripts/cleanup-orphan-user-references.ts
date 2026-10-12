/**
 * BP-1036: for every user id that something still names and no account answers to, erase what a
 * deletion erases by id today: notifications, PM conversations, consents, accepted invitations,
 * assignee / assigned-by / PM-assigned / watcher references on tasks, personal agents and the
 * blocks they authored, machines.
 *
 * What an id cannot find stays: a username in history or the audit logs, and an invitation sent to
 * an address, since both were written under a name the deleted account no longer gives us.
 *
 * Only the default organisation, as cleanup-orphan-grants.ts: on an instance with other
 * organisations, run it against each. Run the dry run first. A user row with no organisation is
 * invisible to it, which would list that person's references as orphans; boot warns about such rows.
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/cleanup-orphan-user-references.ts            # reports, writes nothing
 *   MONGODB_URI=... npx tsx scripts/cleanup-orphan-user-references.ts --apply
 *
 * Against production, through a tunnel: the first command holds it open and prints <port>, the
 * second runs in another terminal and is where --apply goes:
 *   railway connect MongoDB --tunnel-only
 *   railway run --service MongoDB -- sh -c 'MONGODB_URI="mongodb://$MONGOUSER:$MONGOPASSWORD@127.0.0.1:<port>/?authSource=admin&directConnection=true" \
 *     npx tsx scripts/cleanup-orphan-user-references.ts'
 *
 * Safe to run again. Reads each id's account once more just before erasing it.
 */
import mongoose from "mongoose";
import { resolveUri, dbName } from "./mongo-uri";
import { eraseOrphanReferences, findOrphanReferences } from "../src/lib/account-erasure";
import { scopedToDefaultOrganisation } from "../src/lib/db-scope";

const APPLY = process.argv.includes("--apply");

async function main() {
  const db = scopedToDefaultOrganisation();
  const { uri, source } = resolveUri();
  // The erasure connects through connectDB, which reads this variable and nothing else
  process.env.MONGODB_URI = uri;
  await mongoose.connect(uri, { autoIndex: false, ...(dbName() ? { dbName: dbName() } : {}) });
  console.log(`Connected via ${source} to database "${mongoose.connection.name}"${APPLY ? "" : " (dry run)"}`);

  const orphans = await findOrphanReferences(db);
  console.log(`Ids with no account: ${orphans.ids.length} (checked against ${orphans.userCount} user(s))`);
  for (const [source, count] of Object.entries(orphans.bySource).sort()) console.log(`  ${source}: ${count}`);
  for (const id of orphans.ids) console.log(`  ${id}`);

  if (!APPLY) {
    console.log("\nNothing changed. Re-run with --apply to erase what names them.");
  } else {
    console.log(`\nErased what names ${await eraseOrphanReferences(db, orphans)} id(s).`);
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
