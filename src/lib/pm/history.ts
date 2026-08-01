export interface PmHistoryAuthor {
  username?: string;
  fullName?: string;
}

export interface PmHistoryEntry {
  role: string;
  content?: string;
  actions?: { summary?: string }[];
  triggeredBy?: PmHistoryAuthor | unknown;
}

export const HISTORY_AUTHOR_PREFIX = "[from @";

function authorOf(entry: PmHistoryEntry): string | null {
  const author = entry.triggeredBy as PmHistoryAuthor | null;
  const username = author && typeof author === "object" ? author.username : undefined;
  return typeof username === "string" && username ? username : null;
}

// Past actions are replayed as their own system record, never appended to the assistant's
// content. Anything sitting in the assistant channel is a style example the model imitates,
// and it learned to emit "[Actions taken: ...]" as prose without ever calling a tool.
export function replayHistory(history: PmHistoryEntry[]): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const entry of history) {
    const content = (entry.content || "").trim();
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
