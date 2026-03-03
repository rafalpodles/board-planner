"use client";

import { useState } from "react";
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
  selectedTasks?: Set<string>;
  onStatusChange: (taskId: string, status: string) => void;
  onTaskClick: (taskId: string) => void;
  onTaskSelect?: (taskId: string) => void;
}

export function Column({
  status,
  tasks,
  projectKey,
  selectedTasks,
  onStatusChange,
  onTaskClick,
  onTaskSelect,
}: ColumnProps) {
  const [isDragOver, setIsDragOver] = useState(false);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsDragOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        const taskId = e.dataTransfer.getData("text/plain");
        if (taskId) {
          onStatusChange(taskId, status);
        }
      }}
      className={`bg-bg-card rounded-xl border border-border
        border-t-2 ${statusBorderColors[status]} flex flex-col max-h-[calc(100vh-12rem)]
        transition-colors ${isDragOver ? "bg-primary/5 border-primary/30" : ""}`}
    >
      <div className="px-3 py-2.5 flex items-center justify-between border-b border-border">
        <h3 className="text-sm font-medium">{STATUS_LABELS[status]}</h3>
        <span className="text-xs text-text-muted bg-bg-input rounded-full px-2 py-0.5">
          {tasks.length}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-y-contain p-2 space-y-2">
        {tasks.map((task) => (
          <TaskCard
            key={task._id}
            task={task}
            projectKey={projectKey}
            selected={selectedTasks?.has(task._id)}
            selectionActive={(selectedTasks?.size ?? 0) > 0}
            onSelect={onTaskSelect}
            onClick={() => onTaskClick(task._id)}
          />
        ))}
        {tasks.length === 0 && (
          <p className="text-xs text-text-muted/50 text-center py-6">
            Drop tasks here
          </p>
        )}
      </div>
    </div>
  );
}
