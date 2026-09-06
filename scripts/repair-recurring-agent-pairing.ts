import mongoose, { Types } from "mongoose";
import { resolveUri, dbName } from "./mongo-uri";
import { Task } from "../src/models/task";
import { Project } from "../src/models/project";
import { personalAgentAlienTo } from "../src/lib/task-service";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const { uri, source } = resolveUri();
  await mongoose.connect(uri, dbName() ? { dbName: dbName() } : undefined);
  console.log(`Connected via ${source}${DRY_RUN ? " (dry run)" : ""}`);

  const seriesRootIds = await Task.distinct("recurringParentId", { recurringParentId: { $ne: null } });

  const candidates = await Task.find({
    agent: { $ne: null },
    $or: [
      { recurrence: { $ne: null } },
      { recurringParentId: { $ne: null } },
      { _id: { $in: seriesRootIds } },
    ],
  })
    .select("project taskNumber title assignee agent")
    .lean();

  console.log(`${candidates.length} recurring task(s) carry an agent — checking each pairing`);

  const projectKeys = new Map<string, string>();
  async function keyFor(projectId: string): Promise<string> {
    if (!projectKeys.has(projectId)) {
      const project = await Project.findById(projectId, "key").lean();
      projectKeys.set(projectId, project?.key ?? projectId);
    }
    return projectKeys.get(projectId)!;
  }

  const verdicts = new Map<string, Promise<boolean>>();
  function alienTo(agent: unknown, assignee: unknown): Promise<boolean> {
    const key = `${String(agent)}::${String(assignee ?? "")}`;
    if (!verdicts.has(key)) verdicts.set(key, personalAgentAlienTo(agent, assignee));
    return verdicts.get(key)!;
  }

  let affected = 0;
  let cleared = 0;
  let failed = 0;
  for (const task of candidates) {
    if (!Types.ObjectId.isValid(task.agent as never)) {
      failed++;
      console.error(`skipping task ${task._id} — agent is not a valid id (${task.agent})`);
      continue;
    }

    const alien = await alienTo(task.agent, task.assignee);
    if (!alien) continue;

    affected++;
    const key = await keyFor(String(task.project));

    if (DRY_RUN) {
      console.log(`would clear agent on ${key}-${task.taskNumber} ("${task.title}")`);
      continue;
    }

    const result = await Task.updateOne(
      { _id: task._id, agent: task.agent },
      { $set: { agent: null } }
    );
    if (result.matchedCount === 0) {
      console.log(`skipped ${key}-${task.taskNumber} — changed or removed since this run started`);
    } else {
      cleared++;
      console.log(`cleared agent on ${key}-${task.taskNumber} ("${task.title}")`);
    }
  }

  console.log(
    `\nDone. ${affected} of ${candidates.length} carried a stale pairing` +
      (failed > 0 ? `, ${failed} could not be judged (see above)` : "") +
      "." +
      (DRY_RUN
        ? " Re-run without --dry-run to clear them."
        : ` ${cleared} cleared.`)
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Repair failed:", err);
  process.exit(1);
});
