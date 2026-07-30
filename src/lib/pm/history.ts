export interface PmHistoryEntry {
  role: string;
  content?: string;
  actions?: { summary?: string }[];
}

// Past actions are replayed as their own system record, never appended to the assistant's
// content. Anything sitting in the assistant channel is a style example the model imitates,
// and it learned to emit "[Actions taken: ...]" as prose without ever calling a tool.
export function replayHistory(history: PmHistoryEntry[]): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const entry of history) {
    const content = (entry.content || "").trim();
    if (content) messages.push({ role: entry.role, content });
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
