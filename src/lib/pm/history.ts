export interface PmHistoryAuthor {
  username?: string;
  fullName?: string;
}

export interface PmHistoryEntry {
  role: string;
  content?: string;
  actions?: { summary?: string }[];
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
export function replayHistory(history: PmHistoryEntry[]): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const entry of history) {
    const content = stripSpoofedLabels((entry.content || "").trim());
    if (content) {
      // The thread is shared, so an unlabelled message is one the model may read as the
      // current user's own earlier instruction and act on
      const username = entry.role === "user" ? authorOf(entry) : null;
      messages.push({
        role: entry.role,
        content: username ? `${HISTORY_AUTHOR_PREFIX}${username}] ${content}` : content,
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
