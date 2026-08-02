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
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

const openDialogs: HTMLElement[] = [];

// A nested dialog renders inside its parent's panel, so containment — not open order — decides which is on top
function topmostDialog() {
  const innermost = openDialogs.filter(
    (dialog) => !openDialogs.some((other) => other !== dialog && dialog.contains(other))
  );
  return innermost[innermost.length - 1];
}

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: keyof typeof SIZE_CLASSES;
}

export function Modal({ open, onClose, title, children, size = "md" }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

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
    const trigger = document.activeElement as HTMLElement | null;
    dialogRef.current!.focus();
    return () => {
      if (trigger?.isConnected) trigger.focus();
    };
  }, [open]);

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

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      );
      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }

      const active = document.activeElement;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
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
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
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
