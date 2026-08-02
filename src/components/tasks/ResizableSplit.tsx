"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMediaQuery } from "@/hooks/use-media-query";

const WIDTH_KEY = "task-detail-aside-width";
const COLLAPSED_KEY = "task-detail-aside-collapsed";

export const DEFAULT_ASIDE = 360;
export const MIN_ASIDE = 260;
export const MIN_MAIN = 320;
const DIVIDER = 9;
const KEYBOARD_STEP = 24;

export function clampAside(width: number, containerWidth: number): number {
  const room = containerWidth - MIN_MAIN - DIVIDER;
  // A container too narrow for both minimums still owes the aside its minimum;
  // the layout is stacked at that size anyway
  const max = Math.max(MIN_ASIDE, room);
  return Math.min(Math.max(width, MIN_ASIDE), max);
}

function readStoredWidth(): number {
  const stored = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_ASIDE;
}

interface ResizableSplitProps {
  children: React.ReactNode;
  aside: React.ReactNode;
  /** Names the aside in the divider and toggle labels */
  asideLabel: string;
}

export function ResizableSplit({ children, aside, asideLabel }: ResizableSplitProps) {
  const isWide = useMediaQuery("(min-width: 1024px)");
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_ASIDE);
  const [collapsed, setCollapsed] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Held key repeats can outrun rendering, and a nudge computed from the last
  // rendered width would then keep restarting from the same base
  const widthRef = useRef(DEFAULT_ASIDE);

  useEffect(() => {
    widthRef.current = readStoredWidth();
    setWidth(widthRef.current);
    setCollapsed(localStorage.getItem(COLLAPSED_KEY) === "1");
  }, []);

  const applyWidth = useCallback((next: number) => {
    const container = containerRef.current;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;
    // An unmeasured container clamps every width down to the minimum, and
    // persisting that would quietly destroy the stored preference
    if (containerWidth < MIN_ASIDE + MIN_MAIN) return;
    const clamped = clampAside(next, containerWidth);
    widthRef.current = clamped;
    setWidth(clamped);
    localStorage.setItem(WIDTH_KEY, String(clamped));
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      localStorage.setItem(COLLAPSED_KEY, prev ? "0" : "1");
      return !prev;
    });
  }, []);

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    const container = containerRef.current;
    if (!container) return;
    applyWidth(container.getBoundingClientRect().right - e.clientX);
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      applyWidth(widthRef.current + KEYBOARD_STEP);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      applyWidth(widthRef.current - KEYBOARD_STEP);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleCollapsed();
    }
  }

  const split = isWide && !collapsed;

  return (
    <div
      ref={containerRef}
      className={split ? "grid items-start" : ""}
      style={split ? { gridTemplateColumns: `minmax(0,1fr) ${DIVIDER}px ${width}px` } : undefined}
    >
      <div className="min-w-0 space-y-6">{children}</div>

      {split && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${asideLabel}`}
          aria-valuenow={width}
          aria-valuemin={MIN_ASIDE}
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={handleKeyDown}
          className={`focus-ring group relative h-full cursor-col-resize touch-none self-stretch ${
            dragging ? "bg-primary/40" : "hover:bg-primary/20"
          }`}
        >
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border"
          />
        </div>
      )}

      {collapsed ? (
        <div className="mt-6 border-t border-border pt-6">
          <button
            type="button"
            onClick={toggleCollapsed}
            className="focus-ring rounded-md px-2 py-1.5 text-sm text-text-muted transition-colors hover:bg-bg-hover hover:text-text"
          >
            Show {asideLabel}
          </button>
        </div>
      ) : (
        <aside
          className={
            split
              ? "min-w-0 pl-6"
              : "mt-6 min-w-0 border-t border-border pt-6"
          }
        >
          {isWide && (
            <div className="mb-2 flex justify-end">
              <button
                type="button"
                onClick={toggleCollapsed}
                className="focus-ring rounded-md px-2 py-1 text-xs text-text-muted transition-colors hover:bg-bg-hover hover:text-text"
              >
                Hide {asideLabel}
              </button>
            </div>
          )}
          {aside}
        </aside>
      )}
    </div>
  );
}
