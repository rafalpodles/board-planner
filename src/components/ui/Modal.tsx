"use client";

import { useEffect, useId, useRef } from "react";

const SIZE_CLASSES = {
  sm: "sm:max-w-md",
  md: "sm:max-w-lg",
  lg: "sm:max-w-2xl",
  // Wide enough for the two-column task detail; lg would clip it to one column
  xl: "sm:max-w-6xl",
} as const;

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

const UNNAMED_DIALOG_LABEL = "Dialog";

const openDialogs: HTMLElement[] = [];

// All overlays share z-50, so the dialog last in the DOM is the one painted in front
function topmostDialog() {
  return openDialogs.reduce<HTMLElement | undefined>(
    (top, dialog) =>
      top && !(top.compareDocumentPosition(dialog) & Node.DOCUMENT_POSITION_FOLLOWING)
        ? top
        : dialog,
    undefined
  );
}

// The selector matches markup; only these checks tell us what a keyboard user can actually reach
function tabbablesWithin(dialog: HTMLElement) {
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
      (el === dialog || parent === null || isRendered(parent));
    rendered.set(el, ok);
    return ok;
  }

  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) =>
      isRendered(el) &&
      (el.tagName === "SUMMARY" || !el.closest("details:not([open])"))
  );
}

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: keyof typeof SIZE_CLASSES;
  /** Where focus lands on close when nothing was focused at open time — keyboard shortcuts, Safari clicks */
  returnFocusTo?: React.RefObject<HTMLElement | null>;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  size = "md",
  returnFocusTo,
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const named = title.trim().length > 0;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current!;
    openDialogs.push(dialog);
    document.body.style.overflow = "hidden";
    return () => {
      const at = openDialogs.indexOf(dialog);
      if (at >= 0) openDialogs.splice(at, 1);
      if (openDialogs.length === 0) document.body.style.overflow = "";
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const focused = document.activeElement as HTMLElement | null;
    const trigger =
      focused && focused !== document.body && focused !== document.documentElement
        ? focused
        : null;
    dialogRef.current!.focus();
    return () => {
      const target = trigger ?? returnFocusTo?.current ?? null;
      if (target?.isConnected) target.focus();
    };
  }, [open, returnFocusTo]);

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      const dialog = dialogRef.current;
      if (!dialog || topmostDialog() !== dialog) return;
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const focusable = tabbablesWithin(dialog);
      const active = document.activeElement;
      const first = focusable[0] ?? dialog;
      const last = focusable[focusable.length - 1] ?? dialog;
      const leavingForwards = !e.shiftKey && (active === last || !dialog.contains(active));
      const leavingBackwards =
        e.shiftKey && (active === first || active === dialog || !dialog.contains(active));

      if (leavingForwards) {
        e.preventDefault();
        first.focus();
      } else if (leavingBackwards) {
        e.preventDefault();
        last.focus();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target !== overlayRef.current) return;
        if (topmostDialog() !== dialogRef.current) return;
        onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={named ? titleId : undefined}
        aria-label={named ? undefined : UNNAMED_DIALOG_LABEL}
        tabIndex={-1}
        className={`flex flex-col w-full ${SIZE_CLASSES[size]} max-h-[90vh]
        bg-bg-card border border-border rounded-t-2xl sm:rounded-2xl p-4 sm:p-6 sm:mx-4
        animate-in slide-in-from-bottom sm:slide-in-from-bottom-0`}>
        <div className="flex shrink-0 items-center justify-between mb-4">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="p-2 rounded-lg hover:bg-bg-hover text-text-muted min-h-[44px] min-w-[44px] flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            &#x2715;
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
