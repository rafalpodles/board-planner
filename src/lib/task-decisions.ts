import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { Task } from "@/models/task";
import { Worker } from "@/models/worker";
import { ApiTaskDecision, ITaskDecision, IUser, TaskDecisionState } from "@/types";

/** Nothing is owed on these any more, and a new claim leaves them alone. */
const SETTLED: TaskDecisionState[] = ["delivered", "discarded", "abandoned", "superseded"];

/**
 * What a person may accept. `refused` and `failed` are here because neither is a dead end: the
 * machine looked and could not deliver, and a transient network fault must not cost a second
 * reading of the same diff.
 */
const ACCEPTABLE_FROM: TaskDecisionState[] = ["pending", "refused", "failed"];

/** Declining is a reply to the question, and the question is only asked once. */
const DECLINABLE_FROM: TaskDecisionState[] = ["pending"];

/**
 * Everything not settled. The design says "any live decision", meaning the ones waiting on a
 * machine that may never come back; `refused` and `failed` are included because a person who does
 * not want to retry one has no other way to make the panel go away.
 */
const ABANDONABLE_FROM: TaskDecisionState[] = ["pending", "accepted", "declined", "refused", "failed"];

/** What the machine may report, and from where. Nothing else settles a record. */
const SETTLEMENTS: Record<string, TaskDecisionState[]> = {
  delivered: ["accepted"],
  refused: ["accepted"],
  failed: ["accepted"],
  discarded: ["declined"],
};

export type Verdict = "accept" | "decline" | "abandon";

const VERDICT_STATE: Record<Verdict, TaskDecisionState> = {
  accept: "accepted",
  decline: "declined",
  abandon: "abandoned",
};

const VERDICT_FROM: Record<Verdict, TaskDecisionState[]> = {
  accept: ACCEPTABLE_FROM,
  decline: DECLINABLE_FROM,
  abandon: ABANDONABLE_FROM,
};

export function isSettled(state: TaskDecisionState): boolean {
  return SETTLED.includes(state);
}

/** What a new claim on the task sweeps away, so `superseded` and this list cannot drift apart. */
export function supersedableStates(): TaskDecisionState[] {
  return ["pending", "accepted", "declined", "refused", "failed"];
}

export interface DecisionRecord {
  gate: string;
  files: string[];
  fileCount: number;
  protectedFiles: string[];
  protectedFileCount: number;
  patch: string;
  patchTruncated: boolean;
  patchSha256: string;
  commit: string;
  taskKey: string;
  title: string;
  acceptable: boolean;
  unacceptableReason: string;
}

export type DecisionResult =
  | { ok: true; decision: ITaskDecision }
  | { ok: false; error: string; status: number };

/**
 * The machine's own write, at refusal time.
 *
 * Filtered on the run, not merely on the task: the record says "this machine is holding this
 * commit in a worktree", and only a worker that still holds the task can truthfully say it. The
 * filter also refuses to overwrite a record somebody has already answered — a retried post after a
 * verdict must not put the question back.
 */
export async function createDecision(
  taskId: string,
  workerId: string,
  runId: string,
  record: DecisionRecord
): Promise<DecisionResult> {
  await connectDB();

  const updated = await Task.findOneAndUpdate(
    {
      _id: taskId,
      "execution.workerId": workerId,
      "execution.runId": runId,
      // A record already waiting on somebody is not replaced. Only a settled one — or none at all
      // — leaves room for the next refusal on the same task.
      $or: [
        { decision: null },
        { decision: { $exists: false } },
        { "decision.state": { $in: SETTLED } },
      ],
    },
    {
      $set: {
        decision: {
          ...record,
          workerId,
          state: "pending" as TaskDecisionState,
          decidedBy: null,
          decidedAt: null,
          prUrl: "",
          error: "",
          attempts: 0,
          createdAt: new Date(),
        },
      },
    },
    { new: true }
  );

  if (!updated?.decision) {
    return {
      ok: false,
      error: "no live run of this worker holds that task, or a decision on it is already waiting",
      status: 409,
    };
  }
  return { ok: true, decision: updated.decision };
}

/**
 * The machine's second write: what came of the verdict.
 *
 * Only `state`, `prUrl`, `error` and `attempts` may move. Everything a person read stays exactly
 * as it was written, which is what makes "you accepted this commit" mean anything afterwards.
 */
export async function settleDecision(
  taskId: string,
  workerId: string,
  state: TaskDecisionState,
  fields: { prUrl?: string; error?: string; attempts?: number } = {}
): Promise<DecisionResult> {
  const from = SETTLEMENTS[state];
  if (!from) {
    return { ok: false, error: `a worker may not settle a decision as ${state}`, status: 400 };
  }

  await connectDB();

  const updated = await Task.findOneAndUpdate(
    { _id: taskId, "decision.workerId": workerId, "decision.state": { $in: from } },
    {
      $set: {
        "decision.state": state,
        "decision.prUrl": fields.prUrl ?? "",
        "decision.error": fields.error ?? "",
        "decision.attempts": fields.attempts ?? 0,
      },
    },
    { new: true }
  );

  if (!updated?.decision) {
    return {
      ok: false,
      error: "that decision is not this worker's, or it is no longer waiting to be settled",
      status: 409,
    };
  }
  return { ok: true, decision: updated.decision };
}

/**
 * The record the caller was actually shown and authorised against.
 *
 * The route reads the document, resolves the machine's owner, and checks `acceptable` — three
 * round trips — and only then writes. `createDecision` replaces any record whose state is settled,
 * so a second run finishing inside that window puts a DIFFERENT change under the same task. Filtered
 * on the state alone, the verdict would land on it: a record this person never read, possibly one
 * belonging to another machine and marked unacceptable. Every field the decision rested on is
 * therefore part of the filter.
 */
export interface DecisionPin {
  workerId: string;
  commit: string;
}

/**
 * A person's verdict.
 *
 * One conditional `findOneAndUpdate` filtered on the states the verdict may come from. Reading the
 * record and then writing it lets a simultaneous Accept and Decline both through, and the two
 * then race each other on the machine.
 */
export async function recordVerdict(
  taskId: string,
  verdict: Verdict,
  userId: string,
  pin: DecisionPin
): Promise<DecisionResult> {
  await connectDB();

  const updated = await Task.findOneAndUpdate(
    {
      _id: taskId,
      "decision.state": { $in: VERDICT_FROM[verdict] },
      "decision.workerId": pin.workerId,
      "decision.commit": pin.commit,
      // Read off the record by the route as well, and restated here because that read is a
      // separate round trip: a change that may not be accepted must not become one between them.
      ...(verdict === "accept" ? { "decision.acceptable": true } : {}),
    },
    {
      $set: {
        "decision.state": VERDICT_STATE[verdict],
        "decision.decidedBy": new Types.ObjectId(userId),
        "decision.decidedAt": new Date(),
        // Cleared with the verdict: the previous attempt's message describes a settlement this
        // one has not reached yet, and leaving it would have the panel explain a failure that is
        // no longer what is happening.
        "decision.error": "",
        "decision.attempts": 0,
      },
    },
    { new: true }
  )
    // Both for the answer this returns — which is the route's response body, and a record a
    // caller renders — and `decidedBy`, an ObjectId until somebody populates it.
    .select(DECISION_FIELDS_A_READER_NEEDS)
    .populate("decision.decidedBy", "username fullName");

  if (!updated?.decision) {
    return {
      ok: false,
      error: "that decision has already been answered, or it is no longer the one you read",
      status: 409,
    };
  }
  return { ok: true, decision: updated.decision };
}

/**
 * Whether this person may answer at all: the machine's **owner**, or an instance admin.
 *
 * Project membership was the first draft's bar, and it is below what this repo already requires to
 * merely *pause* a machine — while accepting is heavier than pausing, since it runs a hostile
 * agent's change under the owner's pinned GitHub identity and against that repository's CI.
 */
export async function mayDecide(
  workerId: string,
  user: { _id: unknown; role?: string },
  // The machine, where the caller already has it. Both readers resolve it for the panel anyway,
  // and the poll runs every ten seconds — two reads of the same document per request is one more
  // than the question needs.
  known?: { owner?: unknown } | null
): Promise<boolean> {
  if (user.role === "admin") return true;
  if (!Types.ObjectId.isValid(workerId)) return false;
  let worker = known;
  if (worker === undefined) {
    await connectDB();
    worker = await Worker.findById(workerId).select("owner").lean<{ owner?: unknown } | null>();
  }
  // typeof null is "object", and a worker whose owner has been released carries null here — so a
  // missing owner must never compare equal to a missing user id.
  return Boolean(worker?.owner) && String(worker!.owner) === String(user._id);
}

function decidedBy(value: ITaskDecision["decidedBy"]): ApiTaskDecision["decidedBy"] {
  if (!value || typeof value !== "object" || !("username" in value)) return null;
  const user = value as IUser;
  return { _id: String(user._id), username: user.username, fullName: user.fullName };
}

/**
 * The `select: false` fields `toApiDecision` reads, re-included.
 *
 * Every reader that hands a whole task document to the serialiser needs exactly these back, and
 * the day one of them was given `select: false` without this string being updated, the panel's
 * "What tripped the gate" disappeared from the product for seven review rounds. `+decision.patch`
 * alone compiles to an EXCLUSION projection, so a new `select: false` field silently joins it: the
 * read keeps working and returns less. Named once, here, beside the function whose appetite it
 * describes.
 *
 * The narrow poll route deliberately does not use this — it withholds the patch, which is the
 * whole reason it exists — and carries its own projection with its own test.
 */
export const DECISION_FIELDS_A_READER_NEEDS = "+decision.patch +decision.protectedFiles";

/**
 * What a reader may see. `patchSha256` and `attempts` are withheld for the reason
 * `toApiExecution` withholds `runId` and `phaseSeq`: they are the machine's own bookkeeping, and
 * publishing the hash invites somebody to think matching it is what accepting checks.
 */
export function toApiDecision(
  decision: ITaskDecision | null | undefined,
  worker?: { name?: string; lastSeenAt?: Date | null } | null,
  canDecide = false
): ApiTaskDecision | undefined {
  if (!decision?.gate) return undefined;
  return {
    gate: decision.gate,
    // The count, not the list — see ApiTaskDecision.fileCount. Both counts are read straight:
    // `createDecision` is the only writer and the route passes both unconditionally, the schema
    // defaults them to 0, and `files` is selected by no reader that reaches here — so a
    // `count || list.length` fallback could never fire, and reading the lists inside a
    // short-circuit made what this function touches depend on the values it is handed.
    fileCount: decision.fileCount ?? 0,
    protectedFiles: decision.protectedFiles ?? [],
    protectedFileCount: decision.protectedFileCount ?? 0,
    patch: decision.patch ?? "",
    patchTruncated: Boolean(decision.patchTruncated),
    commit: decision.commit,
    workerId: decision.workerId,
    ...(worker?.name ? { workerName: worker.name } : {}),
    // The panel says whether anybody is coming back for this, and a machine that has been
    // re-imaged, deregistered or switched off never hears the verdict at all.
    workerLastSeenAt: worker?.lastSeenAt ? new Date(worker.lastSeenAt).toISOString() : null,
    taskKey: decision.taskKey ?? "",
    title: decision.title ?? "",
    acceptable: Boolean(decision.acceptable),
    unacceptableReason: decision.unacceptableReason ?? "",
    canDecide,
    state: decision.state,
    decidedBy: decidedBy(decision.decidedBy),
    decidedAt: decision.decidedAt ? new Date(decision.decidedAt).toISOString() : null,
    prUrl: decision.prUrl ?? "",
    error: decision.error ?? "",
    createdAt: decision.createdAt ? new Date(decision.createdAt).toISOString() : "",
  };
}

/** One decision, as the machine that holds the work needs to see it. */
export interface WorkerDecision {
  taskId: string;
  projectId: string;
  taskKey: string;
  title: string;
  commit: string;
  patchSha256: string;
  state: TaskDecisionState;
  attempts: number;
  /**
   * When a person answered. The machine keeps its own count of what it has spent on a verdict, and
   * this is how it tells one verdict from a retry of the last: every `recordVerdict` stamps a new
   * instant, and nothing else moves it.
   */
  decidedAt: string;
}

/**
 * What this machine is being told, on the refresh it already makes.
 *
 * `pending` records travel too, deliberately: the worker keeps a marker per task to hold the
 * worktree back from the reaper, and the only way to know a marker should be dropped is to see
 * that its decision is no longer among the live ones.
 */
export async function decisionsForWorker(workerId: string): Promise<WorkerDecision[]> {
  await connectDB();

  const tasks = await Task.find({
    "decision.workerId": workerId,
    "decision.state": { $nin: SETTLED },
  })
    .select(
      "project decision.taskKey decision.title decision.commit decision.patchSha256 decision.state decision.attempts decision.decidedAt"
    )
    .lean<
      {
        _id: unknown;
        project: unknown;
        decision?: {
          taskKey?: string;
          title?: string;
          commit?: string;
          patchSha256?: string;
          state?: TaskDecisionState;
          attempts?: number;
          decidedAt?: Date | null;
        };
      }[]
    >();

  return tasks.flatMap((task) =>
    task.decision?.state
      ? [
          {
            taskId: String(task._id),
            projectId: String(task.project),
            taskKey: task.decision.taskKey ?? "",
            title: task.decision.title ?? "",
            commit: task.decision.commit ?? "",
            patchSha256: task.decision.patchSha256 ?? "",
            state: task.decision.state,
            attempts: task.decision.attempts ?? 0,
            decidedAt: task.decision.decidedAt
              ? new Date(task.decision.decidedAt).toISOString()
              : "",
          },
        ]
      : []
  );
}
