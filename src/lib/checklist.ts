import type { CriterionAction } from "@/types";

/**
 * Parse an acceptanceCriteria string (markdown checklist) into structured checklist items.
 * Handles formats like:
 *   - [ ] item text
 *   - [x] completed item
 *   - plain line (treated as unchecked item)
 */
export function parseChecklistString(
  text: string
): { text: string; done: boolean }[] {
  if (!text || typeof text !== "string") return [];

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      // Match "- [x] text" or "- [ ] text" or "* [x] text"
      const checkboxMatch = line.match(/^[-*]\s*\[([ xX])\]\s*(.+)$/);
      if (checkboxMatch) {
        return {
          text: checkboxMatch[2].trim(),
          done: checkboxMatch[1].toLowerCase() === "x",
        };
      }
      // Match "- text" or "* text" (bullet without checkbox)
      const bulletMatch = line.match(/^[-*]\s+(.+)$/);
      if (bulletMatch) {
        return { text: bulletMatch[1].trim(), done: false };
      }
      // Plain text line
      return { text: line, done: false };
    });
}

export interface CriterionChange {
  action: CriterionAction;
  id: string;
  before: string;
  after: string;
}

interface StoredCriterion {
  _id?: unknown;
  text: string;
  done?: boolean;
}

/**
 * What happened to each criterion between two stored lists. A row is the same criterion when its
 * id survived, or — for a row the write minted a fresh id for, which is what a whole-list rewrite
 * from MCP or the AI path does — when its text is identical to one that disappeared.
 */
export function criterionChanges(before: StoredCriterion[], after: StoredCriterion[]): CriterionChange[] {
  const unmatched = new Map(before.map((item) => [String(item._id), item]));
  const pairs: [StoredCriterion | undefined, StoredCriterion][] = after.map((item) => {
    const previous = unmatched.get(String(item._id));
    if (previous) unmatched.delete(String(item._id));
    return [previous, item];
  });
  for (const pair of pairs) {
    if (pair[0]) continue;
    const sameText = [...unmatched.values()].find((item) => item.text === pair[1].text);
    if (!sameText) continue;
    unmatched.delete(String(sameText._id));
    pair[0] = sameText;
  }

  const changes: CriterionChange[] = [...unmatched.values()].map((item) => ({
    action: "criterion_removed",
    id: String(item._id),
    before: item.text,
    after: "",
  }));
  for (const [previous, item] of pairs) {
    const id = String(item._id);
    if (!previous) {
      changes.push({ action: "criterion_added", id, before: "", after: item.text });
      continue;
    }
    if (previous.text !== item.text) {
      changes.push({ action: "criterion_edited", id, before: previous.text, after: item.text });
    }
    if (!!previous.done !== !!item.done) {
      changes.push({
        action: item.done ? "criterion_checked" : "criterion_unchecked",
        id,
        before: "",
        after: item.text,
      });
    }
  }
  return changes;
}
