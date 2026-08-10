/**
 * BP-240: pin `claimScope: "any"` on projects that already had workers enabled.
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/migrate-claim-scope.ts --dry-run
 *   MONGODB_URI=... npx tsx scripts/migrate-claim-scope.ts
 *
 * The new default is "assigned": enabling a project no longer, by itself, offers a worker the whole
 * approved column. That is the right default for a project being enabled today and the wrong change
 * to make under one already running — its worker would stop claiming and nothing would say why.
 *
 * So already-enabled projects keep today's behaviour, pinned in `policyOverrides` rather than left
 * to the default, because a value that merely happens to match a default is indistinguishable from
 * one nobody chose. Pinning records the choice.
 *
 * Run this BEFORE the deploy, or immediately after: a project migrated late spends the gap claiming
 * only assigned tasks, which is a pause, not damage. Safe to re-run — a project that already pins
 * claimScope is left alone, whichever value it pins.
 */

import mongoose from "mongoose";

const dryRun = process.argv.includes("--dry-run");

interface WorkerProject {
  _id: mongoose.Types.ObjectId;
  key?: string;
  worker?: {
    enabled?: boolean;
    policy?: { claimScope?: string };
    policyOverrides?: string[];
  };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle");

  const projects = (await db
    .collection("projects")
    .find({})
    .toArray()) as unknown as WorkerProject[];

  let pinned = 0;
  let alreadyPinned = 0;
  let notEnabled = 0;

  for (const project of projects) {
    const name = project.key || String(project._id);
    const worker = project.worker;

    if (!worker?.enabled) {
      notEnabled++;
      continue;
    }

    if ((worker.policyOverrides ?? []).includes("claimScope")) {
      alreadyPinned++;
      console.log(`${name}: already pins claimScope = ${worker.policy?.claimScope ?? "?"}`);
      continue;
    }

    pinned++;
    console.log(`${name}: claimScope = any (keeping today's behaviour)${dryRun ? " (dry run)" : ""}`);
    if (!dryRun) {
      await db.collection("projects").updateOne(
        { _id: project._id },
        {
          $set: { "worker.policy.claimScope": "any" },
          $addToSet: { "worker.policyOverrides": "claimScope" },
        }
      );
    }
  }

  console.log(
    `\n${dryRun ? "Would pin" : "Pinned"} ${pinned} project(s); ` +
      `${alreadyPinned} already pinned one; ${notEnabled} have no workers enabled and take the ` +
      `"assigned" default.`
  );

  if (!dryRun) console.log("\nRe-run with --dry-run to confirm nothing is left to pin.");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
