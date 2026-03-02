"use client";

import { TaskStatus, Difficulty, Category } from "@/types";

const statusColors: Record<TaskStatus, string> = {
  planned: "bg-status-planned/20 text-status-planned",
  todo: "bg-status-todo/20 text-status-todo",
  in_progress: "bg-status-in-progress/20 text-status-in-progress",
  in_review: "bg-status-in-review/20 text-status-in-review",
  ready_to_test: "bg-status-ready-to-test/20 text-status-ready-to-test",
  done: "bg-status-done/20 text-status-done",
};

const difficultyColors: Record<Difficulty, string> = {
  S: "bg-difficulty-s/20 text-difficulty-s",
  M: "bg-difficulty-m/20 text-difficulty-m",
  L: "bg-difficulty-l/20 text-difficulty-l",
  XL: "bg-difficulty-xl/20 text-difficulty-xl",
};

const categoryColors: Record<Category, string> = {
  bug: "bg-danger/20 text-danger",
  doc: "bg-primary/20 text-primary",
  "user-story": "bg-success/20 text-success",
  idea: "bg-warning/20 text-warning",
};

interface BadgeProps {
  children: React.ReactNode;
  variant?: "status" | "difficulty" | "category" | "default";
  value?: string;
  className?: string;
}

export function Badge({
  children,
  variant = "default",
  value,
  className = "",
}: BadgeProps) {
  let colorClass = "bg-bg-input text-text-muted";

  if (variant === "status" && value && value in statusColors) {
    colorClass = statusColors[value as TaskStatus];
  } else if (variant === "difficulty" && value && value in difficultyColors) {
    colorClass = difficultyColors[value as Difficulty];
  } else if (variant === "category" && value && value in categoryColors) {
    colorClass = categoryColors[value as Category];
  }

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${colorClass} ${className}`}
    >
      {children}
    </span>
  );
}
