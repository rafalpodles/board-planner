/**
 * CP-213: seed Component, Difficulty and Labels as project fields and copy every
 * task's legacy value into `customFieldValues`.
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/migrate-legacy-fields.ts --dry-run
 *   MONGODB_URI=... npx tsx scripts/migrate-legacy-fields.ts
 *
 * Safe to re-run: a project that already has the three definitions is not seeded
 * again, and a task whose values are already copied is left alone. The old columns
 * are not touched, so a rollback loses nothing.
 *
 * Reads fall back to the legacy column (see src/lib/legacy-fields.ts), so this
 * script is an optimisation rather than a prerequisite — an unmigrated database
 * still renders correctly.
 */

import mongoose from "mongoose";
import { legacyFieldSeeds, findLegacyField, migratedValuesFor, withValuesInUse } from "../src/lib/legacy-fields";
import type { ApiCustomField } from "../src/types";

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle");

  const projects = await db.collection("projects").find({}).toArray();
  let seededProjects = 0;
  let migratedTasks = 0;

  for (const project of projects) {
    const existing = (project.customFields || []) as ApiCustomField[];
    const tasks = await db
      .collection("tasks")
      .find({ project: project._id })
      .project({ component: 1, difficulty: 1, labels: 1, customFieldValues: 1 })
      .toArray();

    // Options must cover values already on tasks, or a task holding a component
    // that was removed from the project list loses it on its next save
    const componentsInUse = tasks.map((t) => String(t.component || "")).filter(Boolean);

    let fields = existing;
    const missing = legacyFieldSeeds(project as { components?: string[]; labels?: never })
      .filter((seed) => !existing.some((f) => f.name.toLowerCase() === seed.name.toLowerCase()))
      .map((seed) =>
        seed.name === "Component" ? withValuesInUse(seed, componentsInUse) : seed
      );

    if (missing.length) {
      const withIds = missing.map((seed) => ({ ...seed, _id: new mongoose.Types.ObjectId() }));
      fields = [...existing, ...withIds] as unknown as ApiCustomField[];
      seededProjects++;
      console.log(
        `${project.key}: seeding ${missing.map((f) => f.name).join(", ")}` +
          (dryRun ? " (dry run)" : "")
      );
      if (!dryRun) {
        await db
          .collection("projects")
          .updateOne({ _id: project._id }, { $set: { customFields: fields } });
      }
    }

    for (const task of tasks) {
      const values = migratedValuesFor(
        task as { component?: string; difficulty?: string; labels?: string[] },
        fields
      );
      const current = (task.customFieldValues || {}) as Record<string, unknown>;
      const pending = Object.entries(values).filter(
        ([id, value]) => JSON.stringify(current[id]) !== JSON.stringify(value)
      );
      if (!pending.length) continue;

      migratedTasks++;
      if (!dryRun) {
        await db
          .collection("tasks")
          .updateOne(
            { _id: task._id },
            { $set: Object.fromEntries(pending.map(([id, v]) => [`customFieldValues.${id}`, v])) }
          );
      }
    }
  }

  console.log(
    `${dryRun ? "Would seed" : "Seeded"} ${seededProjects} project(s) and ` +
      `${dryRun ? "would migrate" : "migrated"} ${migratedTasks} task(s).`
  );

  // A second run must report zero, or the migration is not idempotent
  if (!dryRun) console.log("Re-run with --dry-run to confirm it reports nothing left to do.");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
