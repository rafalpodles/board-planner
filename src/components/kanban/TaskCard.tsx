"use client";

import { ApiTask } from "@/types";
import { Badge } from "@/components/ui/Badge";

interface TaskCardProps {
  task: ApiTask;
  projectKey: string;
  selected?: boolean;
  selectionActive?: boolean;
  onSelect?: (taskId: string) => void;
  onClick: () => void;
  onContextMenu?: (taskId: string, x: number, y: number) => void;
}

export function TaskCard({
  task,
  projectKey,
  selected = false,
  selectionActive = false,
  onSelect,
  onClick,
  onContextMenu,
}: TaskCardProps) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", task._id);
        e.dataTransfer.effectAllowed = "move";
      }}
      className={`bg-bg rounded-lg border p-3 cursor-grab
        transition-colors group active:cursor-grabbing relative
        ${selected ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"}`}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(task._id, e.clientX, e.clientY);
      }}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          onSelect?.(task._id);
        } else {
          onClick();
        }
      }}
    >
      {(selectionActive || selected) && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onSelect?.(task._id);
          }}
          className={`absolute top-2 right-2 w-5 h-5 rounded border flex items-center justify-center
            transition-colors text-[10px]
            ${selected
              ? "bg-primary border-primary text-white"
              : "border-border bg-bg-input text-transparent hover:border-primary/50"
            }`}
        >
          {selected && "\u2713"}
        </button>
      )}

      <div className="flex items-start justify-between gap-2 mb-2 pr-6">
        <span className="text-xs font-mono text-text-muted">
          {projectKey}-{task.taskNumber}
        </span>
        <div className="flex gap-1">
          <Badge variant="difficulty" value={task.difficulty}>
            {task.difficulty}
          </Badge>
          <Badge variant="category" value={task.category}>
            {task.category}
          </Badge>
        </div>
      </div>

      <h3 className="text-sm font-medium mb-2 line-clamp-2">{task.title}</h3>

      {task.component && (
        <div className="mb-2">
          <Badge className="text-[10px]">{task.component}</Badge>
        </div>
      )}

      {task.assignee && typeof task.assignee === "object" && (
        <div className="flex items-center">
          <span className="text-xs text-text-muted flex items-center gap-1">
            <span className="w-5 h-5 rounded-full bg-primary/30 flex items-center justify-center text-[10px] font-medium">
              {task.assignee.fullName?.charAt(0).toUpperCase() || "?"}
            </span>
            <span>{task.assignee.username}</span>
          </span>
        </div>
      )}
    </div>
  );
}
