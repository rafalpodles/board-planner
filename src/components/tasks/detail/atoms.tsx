"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { PRIORITIES, Priority } from "@/types";

/** A one-line-looking field that wraps instead of scrolling its text out of sight */
export function GrowingTextarea({
  value,
  onChange,
  onKeyDown,
  onBlur,
  className = "",
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onBlur?: () => void;
  className?: string;
  placeholder?: string;
  "aria-label"?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      className={`resize-none overflow-hidden ${className}`}
      {...rest}
    />
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-bold uppercase tracking-widest text-text-muted">
      {children}
    </div>
  );
}

export function Avatar({
  name,
  size = 28,
  className = "",
}: {
  name?: string | null;
  size?: number;
  className?: string;
}) {
  const initials = (name || "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  if (!initials) {
    return (
      <span
        aria-hidden
        className={`inline-block shrink-0 rounded-full border border-dashed border-border ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-bg-input font-bold text-text ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {initials}
    </span>
  );
}

const PRIORITY_ACCENT: Record<Priority, string> = {
  low: "var(--color-priority-low)",
  medium: "var(--color-priority-medium)",
  high: "var(--color-priority-high)",
  urgent: "var(--color-priority-urgent)",
};

/** Signal-strength bars — one per priority level, filled up to the current one */
export function PriorityBars({ priority }: { priority: Priority }) {
  const level = PRIORITIES.indexOf(priority);
  return (
    <span aria-hidden className="inline-flex items-end gap-[2px]">
      {PRIORITIES.map((_, i) => (
        <i
          key={i}
          className="block w-[3px] rounded-[1px]"
          style={
            {
              height: 5 + i * 2,
              background: i <= level ? PRIORITY_ACCENT[priority] : "var(--color-border)",
            } as CSSProperties
          }
        />
      ))}
    </span>
  );
}

export function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div
      className="h-1 flex-1 overflow-hidden rounded-full bg-bg-input"
      role="progressbar"
      aria-valuenow={done}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label="Acceptance criteria completed"
    >
      <div
        className="h-full rounded-full bg-success transition-[width] duration-200"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
