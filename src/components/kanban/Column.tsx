"use client";

import { ApiTask, TaskStatus, STATUS_LABELS } from "@/types";
import { TaskCard } from "./TaskCard";

const statusBorderColors: Record<TaskStatus, string> = {
  planned: "border-t-status-planned",
  todo: "border-t-status-todo",
  in_progress: "border-t-status-in-progress",
  in_review: "border-t-status-in-review",
  ready_to_test: "border-t-status-ready-to-test",
  done: "border-t-status-done",
};

interface ColumnProps {
  status: TaskStatus;
  tasks: ApiTask[];
  projectKey: string;
  onStatusChange: (taskId: string, status: string) => void;
  onTaskClick: (taskId: string) => void;
}

export function Column({
  status,
  tasks,
  projectKey,
  onStatusChange,
  onTaskClick,
}: ColumnProps) {
  return (
    <div
      className={`bg-bg-card rounded-xl border border-border
        border-t-2 ${statusBorderColors[status]} flex flex-col max-h-[calc(100vh-12rem)]`}
    >
      <div className="px-3 py-2.5 flex items-center justify-between border-b border-border">
        <h3 className="text-sm font-medium">{STATUS_LABELS[status]}</h3>
        <span className="text-xs text-text-muted bg-bg-input rounded-full px-2 py-0.5">
          {tasks.length}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {tasks.map((task) => (
          <TaskCard
            key={task._id}
            task={task}
            projectKey={projectKey}
            onStatusChange={onStatusChange}
            onClick={() => onTaskClick(task._id)}
          />
        ))}
        {tasks.length === 0 && (
          <p className="text-xs text-text-muted text-center py-4">
            No tasks
          </p>
        )}
      </div>
    </div>
  );
}
