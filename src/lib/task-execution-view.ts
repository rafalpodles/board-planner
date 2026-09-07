import { Worker } from "@/models/worker";
import { ITaskExecution } from "@/types";
import { toApiExecution } from "@/lib/task-service";

/**
 * Only runs still holding a task carry a workerId, so this reads a handful of documents at most —
 * and skips the query entirely when nothing is running.
 */
export async function workerNamesFor(
  executions: (ITaskExecution | undefined)[]
): Promise<Map<string, string>> {
  const ids = [...new Set(executions.filter((e) => e?.runId && e.workerId).map((e) => e!.workerId))];
  if (ids.length === 0) return new Map();
  const workers = await Worker.find({ _id: { $in: ids } }).select("name").lean();
  return new Map(workers.map((w: { _id: unknown; name?: unknown }) => [String(w._id), w.name as string]));
}

/**
 * The shape a task is published in. The stored subdocument has defaults on every field, so it
 * serialises as a truthy object even when nothing is running — and the board reads a truthy
 * `execution` as "a machine is touching this right now", drawing the red pulsing indicator.
 *
 * So a write that answers with the raw document does not merely leak the run identity the list
 * route's comment exists to withhold; it paints a run that does not exist onto every card the
 * reader touches, until the next poll clears it (BP-558 review). Every route that returns a task
 * goes through here.
 */
export async function withApiExecution<T extends { execution?: ITaskExecution }>(
  task: T
): Promise<Record<string, unknown>> {
  // Callers hand this either a hydrated document or a plain object, and spreading a document
  // copies its internals rather than its fields
  const asDocument = task as unknown as { toObject?: () => Record<string, unknown> };
  const plain = typeof asDocument.toObject === "function" ? asDocument.toObject() : { ...task };
  const names = await workerNamesFor([task.execution]);
  return { ...plain, execution: toApiExecution(task.execution, names) };
}
