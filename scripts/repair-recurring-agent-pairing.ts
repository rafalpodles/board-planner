/**
 * BP-369: repair a recurring series carrying a personal agent whose owner no longer matches its
 * assignee — see the comment above `agent: oldTask.agent ?? null` in createNextRecurrence
 * (src/lib/task-service.ts) for why the pairing is never re-judged live.
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/repair-recurring-agent-pairing.ts --dry-run
 *   MONGODB_URI=... npx tsx scripts/repair-recurring-agent-pairing.ts
 *
 * Against production, through the database service:
 *   railway run --service MongoDB -- npx tsx scripts/repair-recurring-agent-pairing.ts --dry-run
 *
 * Reuses `personalAgentAlienTo` — the same check `updateTask` runs live — rather than a second
 * copy of the rule. Not a security fix: `snapshotFor` already refuses a stale pairing at claim
 * time; this only stops a card from naming an agent that could never actually run.
 *
 * Scoped to recurring series (`recurrence` or `recurringParentId` set): a non-recurring task with
 * the same stale pairing self-heals the next time anyone edits its assignee through `updateTask`.
 */
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

  // A series root that already spawned a child, then had its OWN `recurrence` turned off (the
  // task detail's "Never" control) has neither field set anymore — invisible to a query on just
  // those two — while never having taken the live self-heal path this script's scope otherwise
  // relies on: clearing `recurrence` doesn't touch `assignee`, so it never trips `updateTask`'s
  // `personalAgentAlienTo` check. Caught by checking whether any task names it as a parent.
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

  // createNextRecurrence copies `agent` and `assignee` together, unchanged, on every occurrence —
  // so a long-running series carries the identical pair across dozens of rows, and an uncached
  // personalAgentAlienTo call would repeat the same Agent lookup once per row. Keyed on the PAIR,
  // not just the agent: the same agent can be legitimately alien to one assignee and not another,
  // so the cache must never answer for a task with a different assignee than the one it was primed
  // for. This is what makes each round trip against `railway run`'s network hop count once per
  // distinct pairing rather than once per row.
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
    // Same guard agentUsableOnProject uses for the same reason: Agent.findById throws on a
    // malformed id, and that's exactly the kind of row this script exists to find.
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

    // Scoped to the exact agent this judgment was made against, not just the row's _id: if
    // somebody legitimately reassigned the task through updateTask while this loop was still
    // working through earlier rows, that write already ran personalAgentAlienTo and may have left
    // a now-valid agent in place — clearing it here on the strength of a stale snapshot would
    // destroy a currently-correct assignment instead of a stale one.
    const result = await Task.updateOne(
      { _id: task._id, agent: task.agent },
      { $set: { agent: null } }
    );
    // The filter above requires `agent` to still equal the snapshot value, so a miss here always
    // means the row moved on its own since the snapshot was taken — deleted, or its agent already
    // changed (through a legitimate edit, or a second run of this same script) — never a partial
    // write: $set on a matched row always changes a non-null agent to null, so matchedCount and
    // modifiedCount can't disagree.
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
