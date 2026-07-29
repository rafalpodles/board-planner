"use client";

import { TaskStatus, Difficulty, Category, Priority } from "@/types";

const statusColors: Record<TaskStatus, string> = {
  planned: "bg-status-planned/20 text-status-planned",
  todo: "bg-status-todo/20 text-status-todo",
  in_progress: "bg-status-in-progress/20 text-status-in-progress",
  in_review: "bg-status-in-review/20 text-status-in-review",
  needs_human_review: "bg-status-needs-human-review/20 text-status-needs-human-review",
  ready_to_test: "bg-status-ready-to-test/20 text-status-ready-to-test",
  done: "bg-status-done/20 text-status-done",
};

const difficultyColors: Record<Difficulty, string> = {
  S: "bg-difficulty-s/20 text-difficulty-s",
  M: "bg-difficulty-m/20 text-difficulty-m",
  L: "bg-difficulty-l/20 text-difficulty-l",
  XL: "bg-difficulty-xl/20 text-difficulty-xl",
};

const priorityColors: Record<Priority, string> = {
  low: "bg-priority-low/20 text-priority-low",
  medium: "bg-priority-medium/20 text-priority-medium",
  high: "bg-priority-high/20 text-priority-high",
  urgent: "bg-priority-urgent/20 text-priority-urgent",
};

const categoryColors: Record<Category, string> = {
  bug: "bg-danger/20 text-danger",
  doc: "bg-primary/20 text-primary",
  "user-story": "bg-success/20 text-success",
  idea: "bg-warning/20 text-warning",
};

interface BadgeProps {
  children: React.ReactNode;
  variant?: "status" | "difficulty" | "priority" | "category" | "default";
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
  let colorClass = "bg-bg-input text-text-muted";

  if (variant === "status" && value && value in statusColors) {
    colorClass = statusColors[value as TaskStatus];
  } else if (variant === "difficulty" && value && value in difficultyColors) {
    colorClass = difficultyColors[value as Difficulty];
  } else if (variant === "priority" && value && value in priorityColors) {
    colorClass = priorityColors[value as Priority];
  } else if (variant === "category" && value && value in categoryColors) {
    colorClass = categoryColors[value as Category];
  }

  if (color) {
    return (
      <span
        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}
        style={{ backgroundColor: `${color}33`, color }}
      >
        {children}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${colorClass} ${className}`}
    >
      {children}
    </span>
  );
}
