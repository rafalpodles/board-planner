"use client";

import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

interface PopoverProps {
  /** Rendered inside the anchor; `toggle` opens and closes the panel */
  trigger: (state: { open: boolean; toggle: () => void }) => ReactNode;
  children: (state: { close: () => void }) => ReactNode;
  align?: "left" | "right";
  /** Panel width; anything Tailwind accepts */
  width?: string;
  label?: string;
}

/** Kept clear of the edge, so a panel flush against it does not read as cut off */
const MARGIN = 8;

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

  /**
   * Anchored to the trigger, the panel runs off whichever edge the trigger is near — measured on a
   * comment whose reactions had pushed the `+` rightwards, the last two emoji were past the card's
   * clip and unreachable by touch (BP-576). This slides it back inside, which is what the reader
   * needs; placing it against the free rectangle rather than the viewport is BP-555's larger job.
   */
  function clamp() {
    const panel = panelRef.current;
    if (!panel) return;
    panel.style.transform = "";
    const rect = panel.getBoundingClientRect();
    // clientWidth, not innerWidth: a classic scrollbar is inside the latter and outside the former
    const past = rect.right - (document.documentElement.clientWidth - MARGIN);
    const before = MARGIN - rect.left;
    // A panel wider than the viewport cannot satisfy both edges, and nothing scrolls it sideways —
    // Math.max keeps the left one in, where reading starts
    const shift = past > 0 ? Math.max(-past, before) : before > 0 ? before : 0;
    if (shift) panel.style.transform = `translateX(${shift}px)`;
  }

  // No deps, deliberately: the anchor travels with its row, and a re-flow that moves it — a
  // reaction landing beside the `+`, say — changes nothing the panel could observe about itself.
  // Re-clamping on every render is what follows it there
  useLayoutEffect(clamp);

  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    // Movement the render cycle does not see: the panel's own content settling, and the viewport
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(clamp);
    observer?.observe(panel);
    window.addEventListener("resize", clamp);
    window.addEventListener("scroll", clamp, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", clamp);
      window.removeEventListener("scroll", clamp, true);
    };
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
