"use client";

import { useId, useRef } from "react";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { topmostLayer } from "@/lib/focus-trap";

const UNNAMED_DIALOG_LABEL = "Dialog";

const SIZE_CLASSES = {
  sm: "sm:max-w-md",
  md: "sm:max-w-lg",
  lg: "sm:max-w-2xl",
  // Wide enough for the two-column task detail; lg would clip it to one column
  xl: "sm:max-w-6xl",
} as const;

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
