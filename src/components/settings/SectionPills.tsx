"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * The horizontal section switcher shown below md on both settings surfaces.
 *
 * `overflow-x-auto` makes this a scroll container, and a scroll container's automatic
 * minimum size is zero — so as a flex item it gets crushed to its padding the moment the
 * page is taller than the viewport. `shrink-0` is what keeps it a row of pills instead of
 * a 4px sliver (BP-365).
 */
export function SectionPillsNav({
  className = "",
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <nav
      data-settings-nav="pills"
      className={`flex shrink-0 items-center gap-2 overflow-x-auto ${className}`}
      aria-label="Settings sections"
    >
      {children}
    </nav>
  );
}

export const pillClass = (active: boolean) =>
  `inline-flex min-h-11 shrink-0 items-center rounded-full border px-4 text-sm transition-colors ${
    active
      ? "border-primary bg-primary-solid font-semibold text-white"
      : "border-border bg-bg-card text-text-muted"
  }`;

/**
 * Tapping a pill switches the section, but the row does not follow — on a phone the pill
 * you just chose is routinely scrolled off-screen, so you lose your place in the row.
 * A callback ref, because the pill is an anchor on one surface and a button on the other.
 */
export function useScrollActivePillIntoView(active: string) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [active]);

  return useCallback((el: HTMLElement | null) => {
    ref.current = el;
  }, []);
}
