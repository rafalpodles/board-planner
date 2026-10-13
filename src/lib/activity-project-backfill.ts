import type { Db, ObjectId } from "mongodb";

export interface ActivityProjectBackfill {
  rowsMissing: number;
  rowsFilled: number;
  tasks: number;
  orphanedTasks: number;
  orphanedRows: number;
}

const BATCH = 500;

/**
 * Gives every activity row written before BP-876 the project of its task. Only rows with no
 * `project` are read or written, so a rerun finds nothing to do; a row whose task has been deleted
 * stays as it is and is counted.
 */
export async function backfillActivityProjects(
  db: Db,
  { apply }: { apply: boolean }
): Promise<ActivityProjectBackfill> {
  const logs = db.collection("activitylogs");
  const tasks = db.collection("tasks");

  const missing = { project: null };
  const result: ActivityProjectBackfill = {
    rowsMissing: await logs.countDocuments(missing),
    rowsFilled: 0,
    tasks: 0,
    orphanedTasks: 0,
    orphanedRows: 0,
  };

  const taskIds = logs.aggregate<{ _id: ObjectId }>(
    [{ $match: missing }, { $group: { _id: "$task" } }],
    { allowDiskUse: true }
  );

  let batch: ObjectId[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const ids = batch;
    batch = [];
    result.tasks += ids.length;

    const owners = await tasks.find({ _id: { $in: ids } }, { projection: { project: 1 } }).toArray();
    const byProject = new Map<string, { project: unknown; ids: ObjectId[] }>();
    for (const { _id, project } of owners) {
      if (!project) continue;
      const key = String(project);
      const held = byProject.get(key);
      if (held) held.ids.push(_id);
      else byProject.set(key, { project, ids: [_id] });
    }

    const placed = new Set<string>();
    for (const { project, ids: ofProject } of byProject.values()) {
      const rows = { task: { $in: ofProject }, ...missing };
      if (apply) result.rowsFilled += (await logs.updateMany(rows, { $set: { project } })).modifiedCount;
      else result.rowsFilled += await logs.countDocuments(rows);
      for (const id of ofProject) placed.add(String(id));
    }

    const orphans = ids.filter((id) => !placed.has(String(id)));
    if (orphans.length > 0) {
      result.orphanedTasks += orphans.length;
      result.orphanedRows += await logs.countDocuments({ task: { $in: orphans }, ...missing });
    }
  };

  for await (const { _id } of taskIds) {
    batch.push(_id);
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  return result;
}
