import { PmAttachment } from "@/types";
import { buildUserContent, MAX_REPLAYED_IMAGES } from "./attachments";

export interface PmHistoryAuthor {
  username?: string;
  fullName?: string;
}

export interface PmHistoryEntry {
  role: string;
  content?: string;
  actions?: { summary?: string }[];
  attachments?: PmAttachment[];
  // Populated to a user, or left as a raw ObjectId when the ref could not be resolved
  triggeredBy?: unknown;
}

export const HISTORY_AUTHOR_PREFIX = "[from @";

function authorOf(entry: PmHistoryEntry): string | null {
  const author = entry.triggeredBy as PmHistoryAuthor | null;
  const username = author && typeof author === "object" ? author.username : undefined;
  return typeof username === "string" && username ? username : null;
}

// The label is the only thing telling the model who wrote a message, so a user must not be
// able to type one and pass their request off as somebody else's
export function stripSpoofedLabels(content: string): string {
  return content.split(HISTORY_AUTHOR_PREFIX).join("(from @");
}

// Past actions are replayed as their own system record, never appended to the assistant's
// content. Anything sitting in the assistant channel is a style example the model imitates,
// and it learned to emit "[Actions taken: ...]" as prose without ever calling a tool.
// Stands in for the words an image-only turn does not have, so no entry is ever replayed as an
// empty message — which is the shape providers reject, and which would then poison every later
// turn in the thread rather than one.
const IMAGE_WITHOUT_WORDS = "(an image, sent without a message)";

export async function replayHistory(
  history: PmHistoryEntry[],
  projectId: string
): Promise<Record<string, unknown>[]> {
  const messages: Record<string, unknown>[] = [];

  // Only the most recent images are re-sent: history replays on every turn, so without a
  // cap the same screenshots are billed again and again and the request grows unbounded
  const imageBearing = history.filter((e) => e.role === "user" && e.attachments?.length);
  const replayable = new Set(imageBearing.slice(-MAX_REPLAYED_IMAGES));

  for (const entry of history) {
    const content = stripSpoofedLabels((entry.content || "").trim());
    // An image-only turn has no text and is still a turn. Keyed on what the entry carries, not on
    // whether its bytes are inside the replay window: outside it there is neither, so the turn
    // vanished while its answer replayed on — the dangling answer this was meant to stop (BP-451).
    const spoken = content || (entry.attachments?.length ? IMAGE_WITHOUT_WORDS : "");
    if (spoken) {
      // The thread is shared, so an unlabelled message is one the model may read as the
      // current user's own earlier instruction and act on
      const username = entry.role === "user" ? authorOf(entry) : null;
      const labelled = username
        ? `${HISTORY_AUTHOR_PREFIX}${username}] ${spoken}`
        : spoken;
      messages.push({
        role: entry.role,
        content: replayable.has(entry)
          ? await buildUserContent(labelled, entry.attachments, projectId)
          : labelled,
      });
    }
    const summaries = (entry.actions || []).map((a) => a?.summary).filter(Boolean);
    if (summaries.length > 0) {
      messages.push({
        role: "system",
        content: `Board actions executed in the previous assistant turn: ${summaries.join("; ")}`,
      });
    }
  }
  return messages;
}
