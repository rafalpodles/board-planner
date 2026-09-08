const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "details > summary:first-of-type",
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

// Overlays share z-50 (the search layer alone is above them), so among equals the one last in the
// DOM is painted in front and owns Escape and Tab. The drawer registers here too, or a dialog
// opened from inside it would fight it for both.
const openLayers: HTMLElement[] = [];

const layerWatchers = new Set<() => void>();
// The subset that is a bottom sheet below `sm`, whose action row is what a toast in the corner
// covers. The drawer, the search layer and a full-screen `bare` dialog are layers too, and none
// of them has one.
const openSheets: HTMLElement[] = [];

interface LayerOptions {
  /** A bottom sheet below `sm`, so anything painted in that corner has to move (BP-590) */
  sheet?: boolean;
  /**
   * How this layer closes itself — the same handler Escape runs. `⌘K` replaces the top layer
   * rather than stacking on it (BP-567), and it does that by asking the layer to close the one
   * way it already knows, so the two cannot drift apart. Returning `false` refuses: a dialog with
   * a write in flight is not replaced out from under its own request.
   */
  close?: () => void | boolean;
}

const layerClose = new Map<HTMLElement, () => void | boolean>();

export function registerLayer(el: HTMLElement, { sheet, close }: LayerOptions = {}): () => void {
  openLayers.push(el);
  if (sheet) openSheets.push(el);
  if (close) layerClose.set(el, close);
  layerWatchers.forEach((notify) => notify());
  return () => {
    const at = openLayers.indexOf(el);
    if (at >= 0) openLayers.splice(at, 1);
    const sheetAt = openSheets.indexOf(el);
    if (sheetAt >= 0) openSheets.splice(sheetAt, 1);
    layerClose.delete(el);
    layerWatchers.forEach((notify) => notify());
  };
}

export function openSheetCount(): number {
  return openSheets.length;
}

/**
 * Asks every open layer to close, top down, and says whether they all agreed.
 *
 * All of them, not only the topmost: layers nest — a confirm opened from the task modal is two —
 * and closing one would leave the palette stacked on the parent, which is the state BP-560 exists
 * to prevent. A refusal stops the walk and answers `false`; the layers below it stay, and so does
 * whatever asked.
 *
 * The list is snapshotted first because closing is a state update: nothing leaves `openLayers`
 * until React commits, so a loop that watched the array for progress would never see any.
 */
export function closeOpenLayers(): boolean {
  for (const el of [...openLayers].reverse()) {
    let answer: void | boolean;
    try {
      answer = layerClose.get(el)?.();
    } catch {
      // A layer that threw on the way out is not a layer that closed. Reported as a refusal
      // rather than left to escape a native keydown listener, where it kills the shortcut for
      // the rest of the session.
      return false;
    }
    if (answer === false) return false;
  }
  return true;
}

/** For anything painted outside a layer that has to know one is there — the toast's geometry */
export function subscribeLayers(notify: () => void): () => void {
  layerWatchers.add(notify);
  return () => {
    layerWatchers.delete(notify);
  };
}

export function openLayerCount(): number {
  return openLayers.length;
}

export function topmostLayer(): HTMLElement | undefined {
  return openLayers.reduce<HTMLElement | undefined>(
    (top, layer) =>
      top && !(top.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING)
        ? top
        : layer,
    undefined
  );
}

// The selector matches markup; only these checks tell us what a keyboard user
// can actually reach — a link inside a display:none branch is not a tab stop.
export function tabbablesWithin(container: HTMLElement): HTMLElement[] {
  const rendered = new Map<Element, boolean>();

  function isRendered(el: HTMLElement): boolean {
    const cached = rendered.get(el);
    if (cached !== undefined) return cached;
    const style = getComputedStyle(el);
    const parent = el.parentElement;
    const ok =
      !el.hidden &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      (el === container || parent === null || isRendered(parent));
    rendered.set(el, ok);
    return ok;
  }

  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => isRendered(el) && (el.tagName === "SUMMARY" || !el.closest("details:not([open])"))
  );
}

/** Returns true when the event was handled and the caller should stop. */
export function cycleTabWithin(container: HTMLElement, e: KeyboardEvent): boolean {
  const focusable = tabbablesWithin(container);
  const active = document.activeElement;
  const first = focusable[0] ?? container;
  const last = focusable[focusable.length - 1] ?? container;
  const leavingForwards = !e.shiftKey && (active === last || !container.contains(active));
  const leavingBackwards =
    e.shiftKey && (active === first || active === container || !container.contains(active));

  if (leavingForwards) {
    e.preventDefault();
    first.focus();
    return true;
  }
  if (leavingBackwards) {
    e.preventDefault();
    last.focus();
    return true;
  }
  return false;
}
