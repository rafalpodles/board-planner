/**
 * BP-877: how long the insights read takes for the projects with the most status rows, as
 * numbers only — never a task or a row. Read-only.
 *
 *   MONGODB_URI=... npx tsx scripts/measure-insights.ts
 */

import mongoose from "mongoose";
import { resolveUri, dbName } from "./mongo-uri";
import { scoped } from "../src/lib/db-scope";
import { projectStatusHistories, STATUS_CHANGE_ACTION } from "../src/lib/status-history";
import { computeInsights, MAX_WEEKS } from "../src/lib/insights";

async function main() {
  const { uri, source } = resolveUri();
  await mongoose.connect(uri, { autoIndex: false, ...(dbName() ? { dbName: dbName() } : {}) });
  console.log(`Database: ${mongoose.connection.name} (from ${source})`);

  const biggest = await mongoose.connection
    .db!.collection("activitylogs")
    .aggregate<{ _id: mongoose.Types.ObjectId; rows: number; organisation: mongoose.Types.ObjectId }>([
      { $match: { action: STATUS_CHANGE_ACTION, project: { $ne: null } } },
      { $group: { _id: "$project", rows: { $sum: 1 }, organisation: { $first: "$organisation" } } },
      { $sort: { rows: -1 } },
      { $limit: 5 },
    ])
    .toArray();

  for (const { _id: project, rows, organisation } of biggest) {
    const db = scoped(organisation);
    const started = performance.now();
    const histories = await projectStatusHistories(db, String(project));
    const read = performance.now();
    const insights = computeInsights(histories, { now: Date.now(), weeks: MAX_WEEKS });
    const done = performance.now();
    console.log(
      JSON.stringify({
        project: String(project),
        tasks: histories.length,
        statusRows: rows,
        finishedInWindow: insights.sample.finished,
        excluded: insights.excluded,
        readMs: Math.round(read - started),
        computeMs: Math.round(done - read),
      })
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
