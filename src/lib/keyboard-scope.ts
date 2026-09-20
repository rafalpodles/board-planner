/**
 * A surface that is on screen without being a layer.
 *
 * `focus-trap.ts` answers the modal question: an open layer owns Escape and Tab, and ⌘K replaces
 * it. A non-modal panel — the PM chat is the only one today — must not answer that question yes:
 * it would take the board's shortcuts away from a board the reader is meant to keep using, and ⌘K
 * would close the panel from under an unrelated action, taking a half-typed message with it. The
 * panel closing on its own Escape is a different thing: that is the reader dismissing it, and the
 * ✕ beside it already ends the draft the same way.
 *
 * What such a panel does own is the keyboard *inside itself*. `ProjectBoardView`'s shortcut
 * handler asks this; the search palette's ⌘K and `/` (`SearchLayer.tsx`) do not, so `/` pressed on
 * a non-typing target inside the panel still opens the palette over it — as it did before this
 * existed (BP-656).
 */
export const OWNS_ITS_KEYS = "data-owns-its-keys";

export function ownsItsKeys(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return typeof el?.closest === "function" && el.closest(`[${OWNS_ITS_KEYS}]`) !== null;
}

/**
 * Did this key land in something the person is typing into?
 *
 * One definition, because there were two (BP-656): the search palette's covered `isContentEditable`
 * and the board's did not. They agreed on every input that exists — the product has no
 * `contentEditable` surface, and `InlineTitle` is a `<textarea>` on purpose — so nothing was broken.
 * The docs were the tie-breaker: `reference/keyboard-shortcuts.md` already promises the keys type
 * rather than fire "with the focus in a text box, a select or anything editable". Editable counts,
 * and a rich-text field added tomorrow is covered before it is written.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable === true
  );
}
