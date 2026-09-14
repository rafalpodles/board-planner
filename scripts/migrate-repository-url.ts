/**
 * CP-242: fill each project's `repositoryUrl` from the legacy `githubRepo` / `gitlabRepo` pair.
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/migrate-repository-url.ts --dry-run
 *   MONGODB_URI=... npx tsx scripts/migrate-repository-url.ts
 *
 * On an instance running GitHub Enterprise, pass `GITHUB_API_BASE_URL` as well — the same value
 * the app runs with. A legacy `githubRepo` of `owner/repo` names no host, so the host has to come
 * from somewhere, and without the variable that somewhere is github.com (BP-634). This script
 * skips a project that already has a `repositoryUrl`, so running it without the variable writes
 * the wrong host permanently rather than being fixed by a second run. The dry run below prints
 * which host it is about to use.
 *
 * Safe to re-run: a project that already has a repositoryUrl is left alone, and the legacy fields
 * are not touched, so a rollback loses nothing.
 *
 * Reads fall back to the legacy pair (src/lib/repository.ts), so this is an optimisation rather
 * than a prerequisite — an unmigrated database still renders, still syncs and still matches
 * workers. Which means the deploy and this script can happen in either order.
 */

import mongoose from "mongoose";
import { githubWebBase } from "../src/lib/github-host";
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

  // Said out loud, because a legacy `githubRepo` carries no host and this is where it gets one.
  // Getting it wrong is not reversible by re-running: a project that already has a url is skipped.
  console.log(`Resolving a legacy githubRepo against ${githubWebBase()}`);

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
