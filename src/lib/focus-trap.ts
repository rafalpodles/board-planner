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

export function registerLayer(el: HTMLElement): () => void {
  openLayers.push(el);
  return () => {
    const at = openLayers.indexOf(el);
    if (at >= 0) openLayers.splice(at, 1);
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
