import { echo } from "@/lib/echo";
export { mergeCriteria } from "@/lib/checklist";

export type Criterion = { _id?: string; text: string; done?: boolean };

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const SHOWN_ITEMS = 8;

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

/** What the API stores per criterion and what a caller needs to address one: id, text, done. */
export const shownCriteria = (items: Criterion[]) =>
  items.map((item) => ({ id: String(item._id), text: item.text, done: !!item.done }));
