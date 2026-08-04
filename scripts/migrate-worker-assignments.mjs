// One-off: worker assignments and work policy moved to the project (CP-232).
//
// Before, a Worker held `assignments: [{project, proposedPath}]` and a nine-field `policy`. Now the
// project decides whether workers may run it and how, and the worker reports the checkouts it has.
// This carries the old intent across; it does not invent an enablement nobody asked for.
//
//   MONGODB_URI=... node scripts/migrate-worker-assignments.mjs [--apply]

import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");
const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is required");
  process.exit(1);
}

const PROJECT_FIELDS = [
  "autoMerge",
  "baseBranch",
  "taskTimeoutMs",
  "maxDiffLines",
  "maxDiffFiles",
  "model",
  "fallbackModel",
  "reviewModel",
];

await mongoose.connect(uri);
const workers = mongoose.connection.collection("workers");
const projects = mongoose.connection.collection("projects");

const plan = [];
for await (const worker of workers.find({ assignments: { $exists: true, $ne: [] } })) {
  for (const assignment of worker.assignments ?? []) {
    if (!assignment?.project) continue;
    const project = await projects.findOne({ _id: assignment.project });
    if (!project) {
      plan.push({ kind: "skip", reason: "project is gone", worker: worker.name });
      continue;
    }

    // Only the fields this worker's operator actually set travel to the project. Copying the whole
    // stored policy would pin every field there forever, which is the bug the override list exists
    // to prevent — one layer up.
    const set = { "worker.enabled": true };
    const overrides = [];
    for (const field of worker.policyOverrides ?? []) {
      if (!PROJECT_FIELDS.includes(field)) continue;
      if (worker.policy?.[field] === undefined) continue;
      set[`worker.policy.${field}`] = worker.policy[field];
      overrides.push(field);
    }
    if (overrides.length > 0) set["worker.policyOverrides"] = overrides;

    plan.push({
      kind: "enable",
      project: project.key ?? String(project._id),
      worker: worker.name,
      path: assignment.proposedPath,
      carried: overrides,
    });
    if (APPLY) await projects.updateOne({ _id: project._id }, { $set: set });
  }

  // The stored inventory is left empty on purpose: only the machine can say what it has, and it
  // reports that on its first heartbeat after the upgrade.
  if (APPLY) await workers.updateOne({ _id: worker._id }, { $unset: { assignments: "" } });
}

for (const entry of plan) {
  if (entry.kind === "skip") {
    console.log(`skip   ${entry.worker}: ${entry.reason}`);
  } else {
    const carried = entry.carried.length ? entry.carried.join(", ") : "nothing pinned";
    console.log(`enable ${entry.project} (was ${entry.worker} at ${entry.path}) — ${carried}`);
  }
}
console.log(
  plan.length === 0
    ? "nothing to migrate"
    : APPLY
      ? `applied ${plan.length} change(s)`
      : `${plan.length} change(s) would be applied; re-run with --apply`
);

// The operator still has to confirm each machine's repos.json lists the checkout that was migrated:
// the path above is no longer sent from the server, so a machine that does not list it locally will
// report the project as unbound rather than silently running from somewhere else.
if (plan.some((e) => e.kind === "enable")) {
  console.log("\ncheck repos.json on each machine still lists the path shown above");
}

await mongoose.disconnect();
