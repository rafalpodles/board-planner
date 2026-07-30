import { connectDB } from "@/lib/db";
import { Project } from "@/models/project";
import { runPmTurn } from "./agent";
import { isOverDailyTurnCap } from "./turn-cap";
import { acquireTurnLock, releaseTurnLock } from "./turn-lock";
import { drainPmTriggers } from "./triggers";
import { getPmUser } from "./pm-user";
import { buildDailyReviewPrompt, dayKeyInTimezone, shouldRunDailyReview } from "./autonomy";

const TICK_MS = Number(process.env.PM_SCHEDULER_TICK_MS) || 5 * 60 * 1000;

let started = false;

export function startPmScheduler(): void {
  if (started) return;
  started = true;
  setInterval(() => {
    pmSchedulerTick().catch((err) => console.error("PM scheduler tick failed:", err));
  }, TICK_MS).unref();
}

export async function pmSchedulerTick(): Promise<void> {
  await connectDB();
  await drainPmTriggers();

  const now = new Date();
  const projects = await Project.find(
    { "pm.enabled": true, "pm.autonomy.dailyReview": true },
    "key pm"
  ).lean();
  if (projects.length === 0) return;

  const pmUser = await getPmUser();

  for (const project of projects) {
    if (!shouldRunDailyReview(now, project.pm?.autonomy)) continue;

    const dayKey = dayKeyInTimezone(now, project.pm!.autonomy!.timezone);
    // Claim the day before running: a crash costs one review instead of a spend loop
    const claimed = await Project.findOneAndUpdate(
      { _id: project._id, "pm.autonomy.lastDailyReviewDay": { $ne: dayKey } },
      { $set: { "pm.autonomy.lastDailyReviewDay": dayKey } }
    );
    if (!claimed) continue;

    await runDailyReview(String(project._id), project.key, project.pm!, String(pmUser._id));
  }
}

async function runDailyReview(
  projectId: string,
  projectKey: string,
  pm: { dailyTurnCap?: number },
  pmUserId: string
): Promise<void> {
  const { over, cap } = await isOverDailyTurnCap(projectId, pm);
  if (over) {
    console.warn(`PM daily review skipped for ${projectKey}: turn cap (${cap}) reached`);
    return;
  }
  const abort = acquireTurnLock(projectId);
  if (!abort) {
    console.warn(`PM daily review skipped for ${projectKey}: a turn is already running`);
    return;
  }
  try {
    const result = await runPmTurn({
      projectId,
      userMessage: buildDailyReviewPrompt(projectKey),
      triggeredByUserId: pmUserId,
      trigger: { type: "daily_review" },
      signal: abort.signal,
    });
    if (!result.ok) console.error(`PM daily review failed for ${projectKey}:`, result.error);
  } finally {
    releaseTurnLock(projectId);
  }
}
