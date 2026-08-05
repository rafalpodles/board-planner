import { Project } from "@/models/project";
import { Task } from "@/models/task";
import { PmTrigger } from "@/models/pmTrigger";
import { IPmTrigger } from "@/types";
import { createNotifications, collectRecipients } from "@/lib/in-app-notifications";
import { explicitEscalationColumnId } from "@/lib/escalation";
import { getPmUser } from "./pm-user";
import { runPmTurn } from "./agent";
import { isOverDailyTurnCap } from "./turn-cap";
import { acquireTurnLock, releaseTurnLock } from "./turn-lock";
import { buildNeedsHumanReviewPrompt } from "./autonomy";
import { getProjectColumns } from "@/lib/columns";
import { isPmRunnable } from "./availability";

const MAX_TRIGGER_ATTEMPTS = 3;

export async function enqueuePmTrigger(
  projectId: string,
  taskId: string,
  taskKey: string
): Promise<void> {
  try {
    await PmTrigger.create({
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

export async function onTaskStatusChanged(args: {
  projectId: string;
  taskId: string;
  oldStatus: string;
  newStatus: string;
  actorId: string;
}): Promise<void> {
  const project = await Project.findById(args.projectId, "key pm columns").lean();
  if (!isPmRunnable(project?.pm) || !project?.pm?.autonomy?.handleNeedsHumanReview) return;

  const escalation = explicitEscalationColumnId(getProjectColumns(project));
  if (!escalation || args.newStatus !== escalation || args.oldStatus === escalation) return;

  const pmUser = await getPmUser();
  if (String(pmUser._id) === args.actorId) return;

  const task = await Task.findById(args.taskId, "taskNumber").lean();
  if (!task) return;

  await enqueuePmTrigger(args.projectId, args.taskId, `${project.key}-${task.taskNumber}`);

  drainPmTriggers().catch((err) => console.error("PM trigger drain failed:", err));
}

async function settleTrigger(
  trigger: IPmTrigger,
  state: "done" | "failed" | "pending",
  lastError = ""
): Promise<void> {
  await PmTrigger.findByIdAndUpdate(trigger._id, {
    $set: { state, lastError, active: state === "pending" },
  });
}

async function failTrigger(trigger: IPmTrigger, error: string): Promise<void> {
  const exhausted = trigger.attempts >= MAX_TRIGGER_ATTEMPTS;
  await settleTrigger(trigger, exhausted ? "failed" : "pending", error);
}

// Reusing comment_added avoids touching the NotificationType enum, model and notifications UI
async function notifyWatchers(
  trigger: IPmTrigger,
  pmUserId: string,
  summary: string
): Promise<void> {
  const task = await Task.findById(trigger.task, "title watchers assignee createdBy").lean();
  if (!task) return;
  createNotifications({
    type: "comment_added",
    taskId: String(trigger.task),
    projectId: String(trigger.project),
    actorId: pmUserId,
    title: `PM reviewed ${trigger.taskKey}`,
    body: summary.slice(0, 120),
    recipientIds: collectRecipients(task),
  });
}

export type PmTriggerOutcome = "ran" | "deferred";

export async function runPmTrigger(trigger: IPmTrigger): Promise<PmTriggerOutcome> {
  const projectId = String(trigger.project);
  const project = await Project.findById(projectId, "pm").lean();
  if (!isPmRunnable(project?.pm) || !project?.pm?.autonomy?.handleNeedsHumanReview) {
    await settleTrigger(trigger, "done");
    return "ran";
  }

  const { over, cap } = await isOverDailyTurnCap(projectId, project.pm);
  if (over) {
    await settleTrigger(trigger, "failed", `Daily turn cap (${cap}) reached`);
    return "ran";
  }

  // A turn is already running for this project — hand the trigger back untouched
  // so a busy lock never burns a retry, and let the next scheduler tick pick it up
  const pmUser = await getPmUser();
  const abort = acquireTurnLock(projectId, String(pmUser._id));
  if (!abort) {
    await settleTrigger(trigger, "pending");
    await PmTrigger.findByIdAndUpdate(trigger._id, { $inc: { attempts: -1 } });
    return "deferred";
  }

  try {
    const result = await runPmTurn({
      projectId,
      userMessage: buildNeedsHumanReviewPrompt(trigger.taskKey),
      triggeredByUserId: String(pmUser._id),
      trigger: { type: "needs_human_review", taskKey: trigger.taskKey },
      signal: abort.signal,
    });
    if (result.ok) {
      await notifyWatchers(trigger, String(pmUser._id), result.message?.content ?? "");
      await settleTrigger(trigger, "done");
    } else {
      await failTrigger(trigger, result.error ?? "PM turn failed");
    }
  } catch (err) {
    await failTrigger(trigger, err instanceof Error ? err.message : String(err));
  } finally {
    releaseTurnLock(projectId);
  }
  return "ran";
}

export async function drainPmTriggers(): Promise<void> {
  for (;;) {
    const claimed = await PmTrigger.findOneAndUpdate(
      { state: "pending" },
      { $set: { state: "running", active: true }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, returnDocument: "after" }
    );
    if (!claimed) return;
    if (claimed.attempts > MAX_TRIGGER_ATTEMPTS) {
      await settleTrigger(claimed, "failed", claimed.lastError || "Retry limit reached");
      continue;
    }
    if ((await runPmTrigger(claimed)) === "deferred") return;
  }
}
