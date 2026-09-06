import { PmMessage } from "@/models/pmMessage";
import { pmThreadFilter } from "./thread";
import { isTurnRunning } from "./turn-lock";

export const ABANDONED_TURN_NOTICE =
  "⚠️ The connection dropped before this answer finished.";

export async function finalizeAbandonedTurns(projectId: string, userId: string): Promise<void> {
  if (isTurnRunning(projectId)) return;
  await PmMessage.updateMany(
    { ...pmThreadFilter(projectId, userId), role: "assistant", content: "" },
    { $set: { content: ABANDONED_TURN_NOTICE } }
  );
}
