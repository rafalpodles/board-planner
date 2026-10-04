import { IPmTrigger } from "@/types";
import { createNotifications, collectRecipients, assigneeIdOf } from "@/lib/in-app-notifications";
import { pillToneForRole } from "@/lib/email-template";
import { explicitEscalationColumnId } from "@/lib/escalation";
import { getPmUser } from "./pm-user";
import { runPmTurn } from "./agent";
import { dailyPmSpend, isOverDailyTurnCap } from "./turn-cap";
import { acquireTurnLock, releaseTurnLock } from "./turn-lock";
import { NEEDS_HUMAN_REVIEW_DISALLOWED_TOOLS, buildNeedsHumanReviewPrompt } from "./autonomy";
import { getProjectColumns } from "@/lib/columns";
import { isPmRunnable } from "./availability";
import { isPmAvailable } from "./config";
import type { ScopedDb } from "@/lib/db-scope";

const MAX_TRIGGER_ATTEMPTS = 3;

export async function enqueuePmTrigger(
  db: ScopedDb,
  projectId: string,
  taskId: string,
  taskKey: string
): Promise<void> {
  try {
    await db.PmTrigger.create({
      project: projectId,
      type: "needs_human_review",
      taskKey,
      task: taskId,
      state: "pending",
    });
  } catch (err) {
    // Duplicate key = a trigger for this task is already queued or running
    if ((err as { code?: number }).code !== 11000) throw err;
  }
}

export async function onTaskStatusChanged(db: ScopedDb, args: {
  projectId: string;
  taskId: string;
  oldStatus: string;
  newStatus: string;
  actorId: string;
}): Promise<void> {
  const project = await db.Project.findById(args.projectId, "key pm columns").lean();
  if (!isPmRunnable(project?.pm) || !project?.pm?.autonomy?.handleNeedsHumanReview) return;

  const escalation = explicitEscalationColumnId(getProjectColumns(project));
  if (!escalation || args.newStatus !== escalation || args.oldStatus === escalation) return;

  const pmUser = await getPmUser(db);
  if (String(pmUser._id) === args.actorId) return;

  const task = await db.Task.findById(args.taskId, "taskNumber").lean();
  if (!task) return;

  await enqueuePmTrigger(db, args.projectId, args.taskId, `${project.key}-${task.taskNumber}`);

  drainPmTriggers(db).catch((err) => console.error("PM trigger drain failed:", err));
}

async function settleTrigger(
  db: ScopedDb,
  trigger: IPmTrigger,
  state: "done" | "failed" | "pending",
  lastError = ""
): Promise<void> {
  await db.PmTrigger.findByIdAndUpdate(trigger._id, {
    $set: { state, lastError, active: state === "pending" },
  });
}

async function failTrigger(db: ScopedDb, trigger: IPmTrigger, error: string): Promise<void> {
  const exhausted = trigger.attempts >= MAX_TRIGGER_ATTEMPTS;
  await settleTrigger(db, trigger, exhausted ? "failed" : "pending", error);
}

// Reusing comment_added avoids touching the NotificationType enum, model and notifications UI
async function notifyWatchers(
  db: ScopedDb,
  trigger: IPmTrigger,
  pmUserId: string,
  summary: string
): Promise<void> {
  const [task, project] = await Promise.all([
    db.Task.findById(trigger.task, "title watchers assignee createdBy status taskNumber").lean(),
    db.Project.findById(trigger.project, "key name columns").lean(),
  ]);
  if (!task) return;
  const column = getProjectColumns(project).find((c) => c.id === String(task.status));
  createNotifications(db, {
    type: "comment_added",
    taskId: String(trigger.task),
    projectId: String(trigger.project),
    actorId: pmUserId,
    title: `PM reviewed ${trigger.taskKey} — needs your call`,
    digestTitle: "PM reviewed this task — needs your call",
    body: summary.slice(0, 120),
    recipientIds: collectRecipients(task),
    email: {
      kicker: "PM review",
      taskKey: trigger.taskKey,
      taskTitle: task.title,
      taskPills: [
        { label: column?.label ?? String(task.status), tone: pillToneForRole(column?.role) },
      ],
      taskMeta: [project?.name, "reviewed by pm"].filter(Boolean).join(" · "),
      quote: { who: "pm · autonomous review", text: summary.slice(0, 200) },
      projectRef: project?.key,
      taskNumber: task.taskNumber,
      assigneeId: assigneeIdOf(task),
    },
  });
}

export type PmTriggerOutcome = "ran" | "deferred";

export async function runPmTrigger(db: ScopedDb, trigger: IPmTrigger): Promise<PmTriggerOutcome> {
  const projectId = String(trigger.project);
  const project = await db.Project.findById(projectId, "pm").lean();
  if (!isPmRunnable(project?.pm) || !project?.pm?.autonomy?.handleNeedsHumanReview) {
    await settleTrigger(db, trigger, "done");
    return "ran";
  }
  // Settled, not retried: without a model every attempt is a turn from the cap spent posting the
  // same warning into every thread
  if (!isPmAvailable()) {
    await settleTrigger(db, trigger, "failed", "The PM agent is not configured on this instance");
    return "ran";
  }

  const { over, cap } = await isOverDailyTurnCap(db, projectId, project.pm);
  if (over) {
    await settleTrigger(db, trigger, "failed", `Daily turn cap (${cap}) reached`);
    return "ran";
  }

  const spend = await dailyPmSpend(db, projectId, project.pm);
  if (spend.over) {
    await settleTrigger(
      db,
      trigger,
      "failed",
      `Daily token cap reached: ${spend.tokens.toLocaleString()} of ${spend.cap.toLocaleString()}`
    );
    return "ran";
  }

  // A turn is already running for this project — hand the trigger back untouched
  // so a busy lock never burns a retry, and let the next scheduler tick pick it up
  const pmUser = await getPmUser(db);
  const abort = acquireTurnLock(projectId, String(pmUser._id));
  if (!abort) {
    await settleTrigger(db, trigger, "pending");
    await db.PmTrigger.findByIdAndUpdate(trigger._id, { $inc: { attempts: -1 } });
    return "deferred";
  }

  try {
    const result = await runPmTurn(db, {
      // Nobody is driving this one — see runPmTurn's `autonomous` (BP-321)
      autonomous: true,
      projectId,
      userMessage: buildNeedsHumanReviewPrompt(trigger.taskKey),
      triggeredByUserId: String(pmUser._id),
      trigger: { type: "needs_human_review", taskKey: trigger.taskKey },
      disallowedTools: NEEDS_HUMAN_REVIEW_DISALLOWED_TOOLS,
      signal: abort.signal,
    });
    if (result.ok) {
      await notifyWatchers(db, trigger, String(pmUser._id), result.message?.content ?? "");
      await settleTrigger(db, trigger, "done");
    } else {
      await failTrigger(db, trigger, result.error ?? "PM turn failed");
    }
  } catch (err) {
    await failTrigger(db, trigger, err instanceof Error ? err.message : String(err));
  } finally {
    releaseTurnLock(projectId);
  }
  return "ran";
}

export async function drainPmTriggers(db: ScopedDb): Promise<void> {
  for (;;) {
    const claimed = await db.PmTrigger.findOneAndUpdate(
      { state: "pending" },
      { $set: { state: "running", active: true }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, returnDocument: "after" }
    );
    if (!claimed) return;
    if (claimed.attempts > MAX_TRIGGER_ATTEMPTS) {
      await settleTrigger(db, claimed, "failed", claimed.lastError || "Retry limit reached");
      continue;
    }
    if ((await runPmTrigger(db, claimed)) === "deferred") return;
  }
}
