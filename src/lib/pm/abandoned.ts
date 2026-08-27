import { PmMessage } from "@/models/pmMessage";
import { pmThreadFilter } from "./thread";
import { isTurnRunning } from "./turn-lock";

export const ABANDONED_TURN_NOTICE =
  "⚠️ The connection dropped before this answer finished.";

/**
 * `runPmTurn` persists the assistant message empty and fills it when the turn ends, so a turn whose
 * server went away — a deploy, an OOM — leaves a stored empty bubble that the chat renders as "…",
 * reading as still typing for ever (BP-484).
 *
 * Repaired on read rather than in the route's `finally`, because a process that dies runs no
 * `finally`. The turn lock is in-process, so an empty assistant message with no turn in flight is
 * abandoned by definition; while one *is* in flight the ellipsis is correct and nothing is touched.
 */
export async function finalizeAbandonedTurns(projectId: string, userId: string): Promise<void> {
  if (isTurnRunning(projectId)) return;
  await PmMessage.updateMany(
    { ...pmThreadFilter(projectId, userId), role: "assistant", content: "" },
    { $set: { content: ABANDONED_TURN_NOTICE } }
  );
}
