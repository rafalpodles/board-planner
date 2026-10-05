import { echo } from "@/lib/echo";

export type Criterion = { _id?: string; text: string; done?: boolean };

const BOX = /^[-*]\s*\[([ xX])\]\s*(.+)$/;
const BULLET = /^[-*]\s+(.+)$/;
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const SHOWN_ITEMS = 8;

/**
 * Reads an acceptanceCriteria markdown list against the criteria the task already holds, so that
 * resending a list with one line changed stops rewriting every item: a line whose text matches a
 * stored one keeps its id, and keeps its done state unless the line states one itself ("- [x]" or
 * "- [ ]"). A plain line says nothing about done, so it must not undo it.
 */
export function mergeCriteria(markdown: string, current: Criterion[]): Criterion[] {
  const unused = [...current];
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const box = line.match(BOX);
      const explicit = box ? box[1].toLowerCase() === "x" : undefined;
      const text = (box ? box[2] : (line.match(BULLET)?.[1] ?? line)).trim();
      const at = unused.findIndex((item) => item.text.trim() === text);
      if (at === -1) return { text, done: explicit ?? false };
      const [kept] = unused.splice(at, 1);
      return { _id: kept._id, text, done: explicit ?? !!kept.done };
    });
}

/** The one criterion a reference names: its id, or its exact text in any case. */
export function findItem(items: Criterion[], ref: string): number {
  const wanted = ref.trim();
  const byId = OBJECT_ID.test(wanted)
    ? items.findIndex((item) => String(item._id).toLowerCase() === wanted.toLowerCase())
    : -1;
  if (byId !== -1) return byId;

  const named = items.flatMap((item, at) => (item.text.trim().toLowerCase() === wanted.toLowerCase() ? [at] : []));
  if (named.length > 1) {
    throw new Error(
      `${named.length} criteria read "${echo(wanted)}" — pass the id of one: ${named.map((at) => items[at]._id).join(", ")}`
    );
  }
  if (named.length === 0) {
    const shown = items.slice(0, SHOWN_ITEMS).map((item) => `"${echo(item.text)}"`).join(", ");
    const more = items.length > SHOWN_ITEMS ? `, and ${items.length - SHOWN_ITEMS} more` : "";
    throw new Error(`No criterion "${echo(wanted)}" on this task, by id or text. It has: ${shown || "none"}${more}`);
  }
  return named[0];
}

export const addItem = (items: Criterion[], text: string, done: boolean): Criterion[] => [...items, { text, done }];

export function setItem(
  items: Criterion[],
  ref: string,
  change: { text?: string; done?: boolean }
): Criterion[] {
  const at = findItem(items, ref);
  return items.map((item, i) => (i === at ? { ...item, ...change } : item));
}

export const removeItem = (items: Criterion[], ref: string): Criterion[] => {
  const at = findItem(items, ref);
  return items.filter((_, i) => i !== at);
};

/** What the API stores per criterion and what a caller needs to address one: id, text, done. */
export const shownCriteria = (items: Criterion[]) =>
  items.map((item) => ({ id: String(item._id), text: item.text, done: !!item.done }));
