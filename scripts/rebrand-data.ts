/**
 * The whole data rebrand in one run: snapshot, migrate, verify.
 *
 *   npx tsx scripts/rebrand-data.ts            # dumps and reports, writes nothing
 *   npx tsx scripts/rebrand-data.ts --apply
 *
 * Add --key CP=BP to change a project's key in the same run. That renames every one of
 * its tasks at once, since a task key is built from it and never stored — see
 * migrate-project-key.ts for what it does to keep the old references working.
 *
 * Against production, from a laptop — the app service's URI is on Railway's private
 * network, so this has to go through the database service:
 *
 *   railway run --service MongoDB -- sh -c 'MONGODB_URI="$MONGO_PUBLIC_URL" npx tsx scripts/rebrand-data.ts'
 *   railway run --service MongoDB -- sh -c 'MONGODB_URI="$MONGO_PUBLIC_URL" npx tsx scripts/rebrand-data.ts --apply'
 *
 * The snapshot is taken **before** anything is written, even on a dry run, and covers
 * every collection rather than a list written by hand — the migration walks the whole
 * database, so a partial dump would read as a safety net without being one.
 *
 * The steps are the existing scripts, run as they would be run by hand. They are not
 * imported and re-implemented here: each one already refuses an empty database, prints
 * which database answered, and has been exercised on its own.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BACKUP_ROOT = process.env.REBRAND_BACKUP_DIR || "./backups";

function run(label: string, args: string[]): string {
  console.log(`\n${"─".repeat(72)}\n${label}\n${"─".repeat(72)}`);
  const res = spawnSync("npx", ["tsx", ...args], {
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf8",
    env: process.env,
  });
  if (res.status !== 0) {
    throw new Error(`${label} failed — stopping before anything else runs.`);
  }
  process.stdout.write(res.stdout);
  return res.stdout;
}

function newestBackup(): string {
  const dirs = readdirSync(BACKUP_ROOT).filter((d) => existsSync(join(BACKUP_ROOT, d, "projects.json")));
  if (!dirs.length) throw new Error(`No dump found under ${BACKUP_ROOT}`);
  return join(BACKUP_ROOT, dirs.sort().at(-1)!);
}

function main() {
  const apply = process.argv.includes("--apply");
  const keyArg = process.argv.find((a) => a.startsWith("--key="))?.slice("--key=".length);
  const [fromKey, toKey] = keyArg ? keyArg.split("=") : [];
  if (keyArg && (!fromKey || !toKey)) throw new Error("--key takes FROM=TO, e.g. --key=CP=BP");

  console.log(apply ? "Rebranding stored data — snapshot, migrate, verify." : "Dry run — a snapshot is still taken.");

  // A dry run stops after the reports, so it must not number its steps out of a plan it
  // will not carry out — "1/5" that ends at 2 reads as a script that gave up
  const steps = apply ? (keyArg ? 6 : 4) : keyArg ? 3 : 2;
  run(`1/${steps}  Snapshot every collection`, ["scripts/dump-collections.ts", "dump", BACKUP_ROOT, "all"]);
  const backup = newestBackup();
  console.log(`\nSnapshot: ${backup}`);

  const scan = run(`2/${steps}  What would change`, ["scripts/migrate-brand.ts", "scan"]);
  if (keyArg) run(`3/${steps}  What the key change would touch`, ["scripts/migrate-project-key.ts", fromKey, toKey]);

  if (!apply) {
    console.log(
      `\nThat is the whole dry run — it reports and stops, by design.\n` +
        `The snapshot above is real. Re-run with --apply to carry it out, which adds\n` +
        `${keyArg ? "the migration, a verifying re-scan and the key change" : "the migration and a verifying re-scan"}.`
    );
    return;
  }

  if (scan.includes("Nothing left to rename")) {
    console.log("\nAlready migrated — nothing to apply.");
    return;
  }

  const offset = keyArg ? 1 : 0;
  run(`${3 + offset}/${steps}  Migrate`, ["scripts/migrate-brand.ts", "apply"]);

  const after = run(`${4 + offset}/${steps}  Verify`, ["scripts/migrate-brand.ts", "scan"]);
  if (!after.includes("Nothing left to rename")) {
    throw new Error(
      "The migration ran but a second scan still finds occurrences. Do not treat this as done — " +
        `restore with:\n  npx tsx scripts/dump-collections.ts restore ${backup}`
    );
  }

  // Last, and only once the name migration has verified: the key change renames every task
  // in the project, and doing that on top of a half-finished rename would be hard to read
  if (keyArg) run(`6/${steps}  Change the project key`, ["scripts/migrate-project-key.ts", fromKey, toKey, "--apply"]);

  console.log(`\n${"─".repeat(72)}`);
  console.log("Done. A second scan found nothing left.");
  console.log(`If anything looks wrong, restore the snapshot — it replaces those collections`);
  console.log(`wholesale, so it also undoes anything written since:`);
  console.log(`  npx tsx scripts/dump-collections.ts restore ${backup}`);
}

try {
  main();
} catch (err) {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
