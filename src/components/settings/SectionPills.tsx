"use client";

import { useCallback, useEffect, useRef } from "react";

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

export function useScrollActivePillIntoView(active: string) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [active]);

  return useCallback((el: HTMLElement | null) => {
    ref.current = el;
  }, []);
}
