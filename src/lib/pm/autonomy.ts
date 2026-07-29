import { IPmAutonomy } from "@/types";

export function hourInTimezone(date: Date, timeZone: string): number {
  const value = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return Number(value);
}

export function dayKeyInTimezone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function shouldRunDailyReview(now: Date, autonomy: IPmAutonomy | undefined): boolean {
  if (!autonomy?.dailyReview) return false;
  if (!isValidTimezone(autonomy.timezone)) return false;
  if (hourInTimezone(now, autonomy.timezone) < autonomy.reviewHour) return false;
  return autonomy.lastDailyReviewDay !== dayKeyInTimezone(now, autonomy.timezone);
}

export function buildDailyReviewPrompt(projectKey: string): string {
  return [
    `Daily board review for ${projectKey}. Nobody is waiting on a reply — this is your own pass over the board.`,
    ``,
    `Look at the board with list_tasks and get_project_stats, then report on:`,
    `- tasks stuck in the same status for a long time`,
    `- tasks in "todo" with no description or no acceptance criteria`,
    `- likely duplicates`,
    `- a pile-up in "ready_to_test" or "in_review"`,
    ``,
    `Fix what is unambiguous: fill in missing acceptance criteria, tighten vague descriptions.`,
    `Do NOT change any status and do NOT create tasks during this review.`,
    `Finish with a short summary: what you changed, and what needs rpo's attention.`,
  ].join("\n");
}

export function buildNeedsHumanReviewPrompt(taskKey: string): string {
  return [
    `Task ${taskKey} was just moved to "needs_human_review".`,
    ``,
    `Read it with get_task and read its comments with list_comments. Then do exactly one of:`,
    `1. If the blocker is answerable from the board and project context, add a comment with your answer and reasoning, and move the task to the status you judge correct.`,
    `2. If it needs a decision only rpo can make, add a comment stating the ONE specific question and the options you see, and leave the status alone.`,
    ``,
    `Do not restate the task description back to us. Be concise and concrete.`,
    `Finish with a one-line summary of which of the two you did and why.`,
  ].join("\n");
}

export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return true;
  } catch {
    return false;
  }
}
