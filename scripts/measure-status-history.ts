/**
 * BP-876: how the project-wide status-history read behaves on a copy of production, as numbers
 * only — row counts and timings, never a row. Read-only.
 *
 *   MONGODB_URI=... npx tsx scripts/measure-status-history.ts
 *
 * Takes the five projects with the most status rows. If a read of the biggest is slow enough to
 * matter, that is the case for keeping `startedAt`/`completedAt` on Task; if it is not, it is not.
 */

import { MongoClient } from "mongodb";
import { resolveUri, dbName } from "./mongo-uri";
import { statusChangeFilter, STATUS_CHANGE_SORT } from "../src/lib/status-history";

async function main() {
  const { uri, source } = resolveUri();
  const client = await MongoClient.connect(uri);
  try {
    const db = client.db(dbName());
    console.log(`Database: ${db.databaseName} (from ${source})`);
    const logs = db.collection("activitylogs");
    const tasks = db.collection("tasks");

    const unfilled = await logs.countDocuments({ project: null });
    console.log(`Rows without a project: ${unfilled}${unfilled ? " (run the backfill first)" : ""}`);
    console.log(`Indexes: ${(await logs.indexes()).map((i) => i.name).join(", ")}`);

    const biggest = await logs
      .aggregate<{ _id: unknown; rows: number; organisation: unknown }>([
        { $match: { action: "status_changed", project: { $ne: null } } },
        { $group: { _id: "$project", rows: { $sum: 1 }, organisation: { $first: "$organisation" } } },
        { $sort: { rows: -1 } },
        { $limit: 5 },
      ])
      .toArray();

    for (const { _id: project, rows, organisation } of biggest) {
      const filter = { ...statusChangeFilter(project as never), organisation };
      const taskCount = await tasks.countDocuments({ project });
      const plan = await logs.find(filter).sort(STATUS_CHANGE_SORT).explain("executionStats");
      const stats = plan.executionStats;
      const winning = JSON.stringify(plan.queryPlanner.winningPlan);
      console.log(
        JSON.stringify({
          project: String(project),
          tasks: taskCount,
          statusRows: rows,
          returned: stats.nReturned,
          docsExamined: stats.totalDocsExamined,
          keysExamined: stats.totalKeysExamined,
          millis: stats.executionTimeMillis,
          indexName: /"indexName":"([^"]+)"/.exec(winning)?.[1] ?? null,
          sortStage: winning.includes('"stage":"SORT"'),
        })
      );
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
