import { connectDB } from "@/lib/db";
import { Project } from "@/models/project";
import { runPmTurn } from "./agent";
import { isOverDailyTurnCap } from "./turn-cap";
import { acquireTurnLock, releaseTurnLock } from "./turn-lock";
import { drainPmTriggers } from "./triggers";
import { getPmUser } from "./pm-user";
import { BOARD_REVIEW_DISALLOWED_TOOLS, buildBoardReviewPrompt, dueReviewSlot } from "./autonomy";
import { buildBoardDigest, digestHeadline, renderBoardDigest } from "./board-review";
import { PM_RUNNABLE_QUERY } from "./availability";

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
    { ...PM_RUNNABLE_QUERY, "pm.autonomy.dailyReview": true },
    "key pm"
  ).lean();
  if (projects.length === 0) return;

  const pmUser = await getPmUser();

  for (const project of projects) {
    const slot = dueReviewSlot(now, project.pm?.autonomy);
    if (!slot) continue;

    // Claim the slot before running: a crash costs one review instead of a spend loop
    const claimed = await Project.findOneAndUpdate(
      { _id: project._id, "pm.autonomy.lastReviewSlot": { $ne: slot } },
      { $set: { "pm.autonomy.lastReviewSlot": slot } }
    );
    if (!claimed) continue;

    await runBoardReview(String(project._id), project.key, project.pm!, String(pmUser._id));
  }
}

async function runBoardReview(
  projectId: string,
  projectKey: string,
  pm: { dailyTurnCap?: number },
  pmUserId: string
): Promise<void> {
  const { over, cap } = await isOverDailyTurnCap(projectId, pm);
  if (over) {
    console.warn(`PM board review skipped for ${projectKey}: turn cap (${cap}) reached`);
    return;
  }
  const abort = acquireTurnLock(projectId);
  if (!abort) {
    console.warn(`PM board review skipped for ${projectKey}: a turn is already running`);
    return;
  }
  try {
    const digest = await buildBoardDigest(projectId);
    if (!digest) return;
    const result = await runPmTurn({
      projectId,
      userMessage: buildBoardReviewPrompt(projectKey, renderBoardDigest(digest)),
      storedMessage: digestHeadline(digest),
      triggeredByUserId: pmUserId,
      trigger: { type: "daily_review" },
      disallowedTools: BOARD_REVIEW_DISALLOWED_TOOLS,
      signal: abort.signal,
    });
    if (!result.ok) console.error(`PM board review failed for ${projectKey}:`, result.error);
  } finally {
    releaseTurnLock(projectId);
  }
}
