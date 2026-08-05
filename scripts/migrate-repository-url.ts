/**
 * CP-242: fill each project's `repositoryUrl` from the legacy `githubRepo` / `gitlabRepo` pair.
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/migrate-repository-url.ts --dry-run
 *   MONGODB_URI=... npx tsx scripts/migrate-repository-url.ts
 *
 * Safe to re-run: a project that already has a repositoryUrl is left alone, and the legacy fields
 * are not touched, so a rollback loses nothing.
 *
 * Reads fall back to the legacy pair (src/lib/repository.ts), so this is an optimisation rather
 * than a prerequisite — an unmigrated database still renders, still syncs and still matches
 * workers. Which means the deploy and this script can happen in either order.
 */

import mongoose from "mongoose";
import { projectRepositoryUrl } from "../src/lib/repository";

const dryRun = process.argv.includes("--dry-run");

interface LegacyProject {
  _id: mongoose.Types.ObjectId;
  key?: string;
  repositoryUrl?: string;
  githubRepo?: string;
  gitlabRepo?: string;
  gitlabHost?: string;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle");

  const projects = (await db.collection("projects").find({}).toArray()) as unknown as LegacyProject[];
  let filled = 0;
  let alreadySet = 0;
  let nothingToDo = 0;
  const bothSet: string[] = [];

  for (const project of projects) {
    const name = project.key || String(project._id);

    if (project.repositoryUrl?.trim()) {
      alreadySet++;
      continue;
    }

    const url = projectRepositoryUrl(project);
    if (!url) {
      nothingToDo++;
      continue;
    }

    // Reported rather than resolved silently: GitHub wins, but which one was dropped is exactly
    // the thing worth a human's eye before the legacy columns are removed.
    if (project.githubRepo?.trim() && project.gitlabRepo?.trim()) {
      bothSet.push(`${name}: kept ${project.githubRepo.trim()}, dropped ${project.gitlabRepo.trim()}`);
    }

    filled++;
    console.log(`${name}: repositoryUrl = ${url}${dryRun ? " (dry run)" : ""}`);
    if (!dryRun) {
      await db.collection("projects").updateOne({ _id: project._id }, { $set: { repositoryUrl: url } });
    }
  }

  console.log(
    `\n${dryRun ? "Would fill" : "Filled"} ${filled} project(s); ` +
      `${alreadySet} already had one; ${nothingToDo} name no repository.`
  );

  if (bothSet.length) {
    console.log(`\n${bothSet.length} project(s) had BOTH fields set — check these:`);
    for (const line of bothSet) console.log(`  ${line}`);
  }

  if (!dryRun) console.log("\nRe-run with --dry-run to confirm it reports nothing left to fill.");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
