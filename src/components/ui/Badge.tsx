"use client";

import type { CSSProperties } from "react";
import { TaskStatus, Category, Priority } from "@/types";

const statusAccents: Record<TaskStatus, string> = {
  planned: "var(--color-status-planned)",
  todo: "var(--color-status-todo)",
  in_progress: "var(--color-status-in-progress)",
  in_review: "var(--color-status-in-review)",
  needs_human_review: "var(--color-status-needs-human-review)",
  ready_to_test: "var(--color-status-ready-to-test)",
  done: "var(--color-status-done)",
};

const priorityAccents: Record<Priority, string> = {
  low: "var(--color-priority-low)",
  medium: "var(--color-priority-medium)",
  high: "var(--color-priority-high)",
  urgent: "var(--color-priority-urgent)",
};

const categoryAccents: Record<Category, string> = {
  bug: "var(--color-danger)",
  doc: "var(--color-primary)",
  "user-story": "var(--color-success)",
  idea: "var(--color-warning)",
};

interface BadgeProps {
  children: React.ReactNode;
  variant?: "status" | "priority" | "category" | "default";
  value?: string;
  // Explicit colour (hex) for project-defined categories; overrides the built-in maps
  color?: string;
  className?: string;
}

export function Badge({
  children,
  variant = "default",
  value,
  color,
  className = "",
}: BadgeProps) {
  let accent: string | undefined = color;

  if (!accent) {
    if (variant === "status" && value && value in statusAccents) {
      accent = statusAccents[value as TaskStatus];
    } else if (variant === "priority" && value && value in priorityAccents) {
      accent = priorityAccents[value as Priority];
    } else if (variant === "category" && value && value in categoryAccents) {
      accent = categoryAccents[value as Category];
    }
  }

  const base = "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium";

  if (!accent) {
    return (
      <span className={`${base} bg-bg-input text-text-muted ${className}`}>{children}</span>
    );
  }

  return (
    <span
      className={`${base} chip ${color ? "chip-custom" : ""} ${className}`}
      style={{ "--chip": accent } as CSSProperties}
    >
      {children}
    </span>
  );
}
