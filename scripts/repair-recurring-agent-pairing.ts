/**
 * BP-369: repair a recurring series that carries a personal agent whose owner does not match its
 * assignee.
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/repair-recurring-agent-pairing.ts --dry-run
 *   MONGODB_URI=... npx tsx scripts/repair-recurring-agent-pairing.ts
 *
 * Against production, through the database service:
 *   railway run --service MongoDB -- npx tsx scripts/repair-recurring-agent-pairing.ts --dry-run
 *
 * `createNextRecurrence` copies `assignee` and `agent` from the closing occurrence to the next one
 * without judging the pairing — deliberately; see the comment above that line in
 * src/lib/task-service.ts. A live edit through `updateTask` clears a personal agent that has
 * stopped belonging to the assignee (`personalAgentAlienTo`), but that guard did not always exist,
 * and a recurring series is never edited by an ordinary gesture between occurrences — so a pairing
 * that went stale before the guard shipped, or on a parent some earlier code path left
 * inconsistent, reproduces on every future occurrence, forever.
 *
 * This is the same check `updateTask` already runs live, asked once against every stored document
 * instead of only at the moment somebody edits one — imported from task-service.ts rather than
 * re-implemented, so there is one definition of "invalid", not two that can drift apart.
 *
 * Not a security fix: `snapshotFor` already refuses to let a machine run a personal agent it does
 * not own, at claim time, however the document reached that state. This is corrected data, so a
 * card stops silently naming an agent that could never actually run — the drift `updateTask` would
 * have cleared already, had this occurrence ever been edited by hand.
 *
 * Scoped to recurring series only (`recurrence` set, or `recurringParentId` set) — a non-recurring
 * task with the same stale pairing self-heals the moment anyone edits its assignee or assigner
 * through `updateTask`; a recurring series is the one shape nothing ordinary ever touches again.
 */
import mongoose from "mongoose";
import { resolveUri, dbName } from "./mongo-uri";
import { Task } from "../src/models/task";
import { Project } from "../src/models/project";
import { personalAgentAlienTo } from "../src/lib/task-service";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const { uri, source } = resolveUri();
  await mongoose.connect(uri, dbName() ? { dbName: dbName() } : undefined);
  console.log(`Connected via ${source}${DRY_RUN ? " (dry run)" : ""}`);

  const candidates = await Task.find({
    agent: { $ne: null },
    $or: [{ recurrence: { $ne: null } }, { recurringParentId: { $ne: null } }],
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

  let affected = 0;
  for (const task of candidates) {
    const alien = await personalAgentAlienTo(task.agent, task.assignee);
    if (!alien) continue;

    affected++;
    const key = await keyFor(String(task.project));
    console.log(
      `${DRY_RUN ? "would clear" : "clearing"} agent on ${key}-${task.taskNumber} ("${task.title}")`
    );

    if (!DRY_RUN) {
      await Task.updateOne({ _id: task._id }, { $set: { agent: null } });
    }
  }

  console.log(
    `\nDone. ${affected} of ${candidates.length} carried a stale pairing.` +
      (DRY_RUN ? " Re-run without --dry-run to clear them." : " Cleared.")
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Repair failed:", err);
  process.exit(1);
});
