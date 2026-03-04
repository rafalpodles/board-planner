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
