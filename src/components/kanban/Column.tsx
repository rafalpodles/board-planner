"use client";

import { useState } from "react";
import { ApiTask, ApiLabel, TaskStatus, STATUS_LABELS } from "@/types";
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
  projectLabels?: ApiLabel[];
  selectedTasks?: Set<string>;
  onStatusChange: (taskId: string, status: string) => void;
  onTaskDrop?: (taskId: string, status: string, dropIndex: number) => void;
  onTaskClick: (taskId: string) => void;
  onTaskSelect?: (taskId: string) => void;
  onTaskContextMenu?: (taskId: string, x: number, y: number) => void;
}

export function Column({
  status,
  tasks,
  projectKey,
  projectLabels,
  selectedTasks,
  onStatusChange,
  onTaskDrop,
  onTaskClick,
  onTaskSelect,
  onTaskContextMenu,
}: ColumnProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  function handleCardDragOver(e: React.DragEvent, index: number) {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    setDropIndex(e.clientY < midY ? index : index + 1);
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        // If dragging over empty area (not a card), drop at end
        if (e.target === e.currentTarget || (e.target as HTMLElement).closest("[data-column-body]") === e.target) {
          setDropIndex(tasks.length);
        }
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsDragOver(false);
          setDropIndex(null);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        const taskId = e.dataTransfer.getData("text/plain");
        if (taskId) {
          if (onTaskDrop && dropIndex !== null) {
            onTaskDrop(taskId, status, dropIndex);
          } else {
            onStatusChange(taskId, status);
          }
        }
        setDropIndex(null);
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

      <div data-column-body className="flex-1 overflow-y-auto overscroll-y-contain p-2 space-y-2">
        {tasks.map((task, i) => (
          <div key={task._id}>
            {dropIndex === i && (
              <div className="h-0.5 bg-primary rounded-full mx-1 -mt-1 mb-1" />
            )}
            <div onDragOver={(e) => handleCardDragOver(e, i)}>
              <TaskCard
                task={task}
                projectKey={projectKey}
                projectLabels={projectLabels}
                selected={selectedTasks?.has(task._id)}
                selectionActive={(selectedTasks?.size ?? 0) > 0}
                onSelect={onTaskSelect}
                onClick={() => onTaskClick(task._id)}
                onContextMenu={onTaskContextMenu}
              />
            </div>
          </div>
        ))}
        {dropIndex === tasks.length && tasks.length > 0 && (
          <div className="h-0.5 bg-primary rounded-full mx-1 -mt-1" />
        )}
        {tasks.length === 0 && (
          <p className="text-xs text-text-muted/50 text-center py-6">
            Drop tasks here
          </p>
        )}
      </div>
    </div>
  );
}
