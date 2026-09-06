"use client";

import { useId, useRef } from "react";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { topmostLayer } from "@/lib/focus-trap";

const UNNAMED_DIALOG_LABEL = "Dialog";

const SIZE_CLASSES = {
  sm: "sm:max-w-md",
  md: "sm:max-w-lg",
  lg: "sm:max-w-2xl",
  // The task detail's own width, so the modal and the standalone page match
  xl: "sm:max-w-[1240px]",
} as const;

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: keyof typeof SIZE_CLASSES;
  /** Where focus lands on close when nothing was focused at open time — keyboard shortcuts, Safari clicks */
  returnFocusTo?: React.RefObject<HTMLElement | null>;
  /** Drops the header and padding for a child that draws its own frame */
  bare?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  size = "md",
  returnFocusTo,
  bare = false,
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const named = title.trim().length > 0;

  useFocusTrap({
    active: open,
    containerRef: dialogRef,
    onEscape: onClose,
    returnFocusTo,
  });

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target !== overlayRef.current) return;
        if (topmostLayer() !== dialogRef.current) return;
        onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={named && !bare ? titleId : undefined}
        aria-label={named && !bare ? undefined : named ? title : UNNAMED_DIALOG_LABEL}
        tabIndex={-1}
        className={`flex w-full flex-col bg-bg-card ${SIZE_CLASSES[size]} sm:mx-4
        animate-in slide-in-from-bottom sm:slide-in-from-bottom-0
        ${
          bare
            ? // A phone has no room to spend on a backdrop around a whole page of content.
              // Only this variant reaches the top of the screen, so it is the only one that
              // owes the notch any room — and the child's own header sticks right under it.
              `h-dvh overflow-hidden rounded-none border-0 pt-[env(safe-area-inset-top)]
               sm:h-auto sm:max-h-[90vh] sm:rounded-2xl sm:border sm:border-border sm:pt-0`
            : "max-h-[90vh] rounded-t-2xl border border-border p-4 sm:rounded-2xl sm:p-6"
        }`}>
        {!bare && (
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
        )}
        {/* A bare child draws its own frame, header included, and scrolls inside itself:
            padding here would show as a strip above that header, and scrolling here would
            move it. Every other dialog keeps the room its focus rings need. */}
        <div
          tabIndex={bare ? undefined : 0}
          className={
            bare
              ? "flex min-h-0 flex-1 flex-col overflow-hidden"
              : "min-h-0 overflow-y-auto scroll-ring-room focus-ring"
          }
        >
          {children}
        </div>
      </div>
    </div>
  );
}
