/**
 * A surface that is on screen without being a layer.
 *
 * `focus-trap.ts` answers the modal question: an open layer owns Escape and Tab, and ⌘K replaces
 * it. A non-modal panel — the PM chat is the only one today — must not answer that question yes:
 * it would take the board's shortcuts away from a board the reader is meant to keep using, and ⌘K
 * would close the panel and take the half-typed message with it.
 *
 * What it does own is the keyboard *inside itself*, including the control that opened it. A page
 * with a global shortcut handler asks this before acting.
 */
export const OWNS_ITS_KEYS = "data-owns-its-keys";

export function ownsItsKeys(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return typeof el?.closest === "function" && el.closest(`[${OWNS_ITS_KEYS}]`) !== null;
}
