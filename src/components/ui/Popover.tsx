"use client";

import { ReactNode, useEffect, useRef, useState } from "react";

interface PopoverProps {
  /** Rendered inside the anchor; `toggle` opens and closes the panel */
  trigger: (state: { open: boolean; toggle: () => void }) => ReactNode;
  children: (state: { close: () => void }) => ReactNode;
  align?: "left" | "right";
  /** Panel width; anything Tailwind accepts */
  width?: string;
  label?: string;
}

export function Popover({
  trigger,
  children,
  align = "left",
  width = "w-56",
  label,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // The trigger lives inside the anchor, so one contains() check covers both it and
  // the panel — clicking the trigger to close must not read as an outside click
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (anchorRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    // Captured, not bubbled: a modal's Escape handler is a second listener on
    // document, and stopPropagation between two listeners on the same target does
    // nothing — one Escape would close the popover and the dialog holding it
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      anchorRef.current?.querySelector("button")?.focus();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  return (
    <div ref={anchorRef} className="relative">
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <div
          ref={panelRef}
          tabIndex={-1}
          aria-label={label}
          className={`focus-ring absolute z-30 mt-1.5 ${width} ${align === "right" ? "right-0" : "left-0"}
            max-h-72 overflow-y-auto rounded-xl border border-border bg-bg-card p-1.5 shadow-2xl`}
        >
          {children({ close: () => setOpen(false) })}
        </div>
      )}
    </div>
  );
}
