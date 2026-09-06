import mongoose from "mongoose";
import { legacyFieldSeeds, findLegacyField, migratedValuesFor, withValuesInUse } from "../src/lib/legacy-fields";
import { resolveUri, dbName } from "./mongo-uri";
import type { ApiCustomField } from "../src/types";

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const { uri, source } = resolveUri();
  await mongoose.connect(uri, { dbName: dbName() });
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle");
  console.log(`Database: ${db.databaseName} (from ${source})`);

  const projects = await db.collection("projects").find({}).toArray();
  if (!projects.length) {
    throw new Error(`No projects in "${db.databaseName}" — wrong database? Set MONGODB_DB.`);
  }
  let seededProjects = 0;
  let migratedTasks = 0;

  for (const project of projects) {
    const existing = (project.customFields || []) as ApiCustomField[];
    const tasks = await db
      .collection("tasks")
      .find({ project: project._id })
      .project({ component: 1, difficulty: 1, labels: 1, customFieldValues: 1 })
      .toArray();

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

  if (!dryRun) console.log("Re-run with --dry-run to confirm it reports nothing left to do.");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
