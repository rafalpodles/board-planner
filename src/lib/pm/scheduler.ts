import { connectDB } from "@/lib/db";
import { Project } from "@/models/project";
import { runPmTurn } from "./agent";
import { dailyPmSpend, isOverDailyTurnCap } from "./turn-cap";
import { acquireTurnLock, isTurnRunning, releaseTurnLock } from "./turn-lock";
import { drainPmTriggers } from "./triggers";
import { getPmUser } from "./pm-user";
import { BOARD_REVIEW_DISALLOWED_TOOLS, buildBoardReviewPrompt, dueReviewSlot } from "./autonomy";
import { buildBoardDigest, digestHeadline, renderBoardDigest } from "./board-review";
import { PM_RUNNABLE_QUERY } from "./availability";
import { isPmAvailable } from "./config";

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
    // Not claimed while a turn holds the project: a review refused for the lock would spend the slot
    if (isTurnRunning(String(project._id))) continue;

    // Claim the slot before running: a crash costs one review instead of a spend loop
    const claimed = await Project.findOneAndUpdate(
      { _id: project._id, "pm.autonomy.lastReviewSlot": { $ne: slot } },
      { $set: { "pm.autonomy.lastReviewSlot": slot } }
    );
    if (!claimed) continue;

    const review = await startBoardReview(String(project._id), project.key, project.pm!, String(pmUser._id));
    if (review.status === "skipped") {
      console.warn(`PM board review skipped for ${project.key}: ${review.reason}`);
      continue;
    }
    await review.done;
  }
}

export type BoardReviewStart =
  | { status: "started"; done: Promise<void> }
  | { status: "skipped"; reason: string };

/**
 * Checks the caps and takes the project's turn lock before anything is spent, then runs the review
 * in `done`. Split this way so the owner's "Run a review now" can answer at once with why a review
 * cannot run, while the scheduler still awaits one review at a time (BP-471).
 */
export async function startBoardReview(
  projectId: string,
  projectKey: string,
  pm: { dailyTurnCap?: number; autonomy?: { timezone?: string } },
  pmUserId: string
): Promise<BoardReviewStart> {
  // The scheduler starts whether or not a model is configured, and a review without one spent a
  // turn to post a warning into every thread on the board
  if (!isPmAvailable()) return { status: "skipped", reason: "the PM agent is not configured on this instance" };
  const { over, cap } = await isOverDailyTurnCap(projectId, pm);
  if (over) return { status: "skipped", reason: `the daily turn cap (${cap}) is reached` };

  const spend = await dailyPmSpend(projectId, pm);
  if (spend.over) {
    return {
      status: "skipped",
      reason: `the daily token cap is reached (${spend.tokens} of ${spend.cap} across ${spend.calls} calls)`,
    };
  }
  const abort = acquireTurnLock(projectId, pmUserId);
  if (!abort) return { status: "skipped", reason: "a PM turn is already running on this project" };

  const done = (async () => {
    try {
      const digest = await buildBoardDigest(projectId);
      if (!digest) return;
      const result = await runPmTurn({
        // Nobody is driving this one — see runPmTurn's `autonomous` (BP-321)
        autonomous: true,
        projectId,
        userMessage: buildBoardReviewPrompt(projectKey, renderBoardDigest(digest)),
        storedMessage: digestHeadline(digest),
        triggeredByUserId: pmUserId,
        trigger: { type: "daily_review" },
        disallowedTools: BOARD_REVIEW_DISALLOWED_TOOLS,
        signal: abort.signal,
      });
      if (!result.ok) console.error(`PM board review failed for ${projectKey}:`, result.error);
    } catch (err) {
      console.error(`PM board review failed for ${projectKey}:`, err);
    } finally {
      releaseTurnLock(projectId);
    }
  })();
  return { status: "started", done };
}
