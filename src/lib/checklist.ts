export function parseChecklistString(
  text: string
): { text: string; done: boolean }[] {
  if (!text || typeof text !== "string") return [];

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const checkboxMatch = line.match(/^[-*]\s*\[([ xX])\]\s*(.+)$/);
      if (checkboxMatch) {
        return {
          text: checkboxMatch[2].trim(),
          done: checkboxMatch[1].toLowerCase() === "x",
        };
      }
      const bulletMatch = line.match(/^[-*]\s+(.+)$/);
      if (bulletMatch) {
        return { text: bulletMatch[1].trim(), done: false };
      }
      return { text: line, done: false };
    });
}
