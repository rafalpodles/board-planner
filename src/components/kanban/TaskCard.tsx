"use client";

import { ApiTask, ApiLabel } from "@/types";
import { Badge } from "@/components/ui/Badge";

interface TaskCardProps {
  task: ApiTask;
  projectKey: string;
  projectLabels?: ApiLabel[];
  selected?: boolean;
  selectionActive?: boolean;
  onSelect?: (taskId: string) => void;
  onClick: () => void;
  onContextMenu?: (taskId: string, x: number, y: number) => void;
}

export function TaskCard({
  task,
  projectKey,
  projectLabels = [],
  selected = false,
  selectionActive = false,
  onSelect,
  onClick,
  onContextMenu,
}: TaskCardProps) {
  const taskLabels = projectLabels.filter((l) =>
    (task.labels || []).includes(l._id)
  );
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
        <span className="text-xs font-mono text-text-muted flex items-center gap-1">
          {task.pinned && (
            <svg className="w-3 h-3 text-primary" fill="currentColor" viewBox="0 0 24 24">
              <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2z"/>
            </svg>
          )}
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

      {taskLabels.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {taskLabels.map((label) => (
            <span
              key={label._id}
              className="text-[10px] px-1.5 py-0.5 rounded-full text-white font-medium"
              style={{ backgroundColor: label.color }}
            >
              {label.name}
            </span>
          ))}
        </div>
      )}

      {task.blockedBy && task.blockedBy.length > 0 && (
        <div className="mb-2">
          <span className="text-[10px] text-warning bg-warning/10 px-1.5 py-0.5 rounded font-medium">
            Blocked ({task.blockedBy.length})
          </span>
        </div>
      )}

      {task.checklist && task.checklist.length > 0 && (
        <div className="mb-2 flex items-center gap-1.5">
          <div className="flex-1 h-1 bg-bg-input rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all"
              style={{
                width: `${(task.checklist.filter((i) => i.done).length / task.checklist.length) * 100}%`,
              }}
            />
          </div>
          <span className="text-[10px] text-text-muted whitespace-nowrap">
            {task.checklist.filter((i) => i.done).length}/{task.checklist.length}
          </span>
        </div>
      )}

      {task.assignee && typeof task.assignee === "object" && (
        <div className="flex items-center">
          <span className="text-xs text-text-muted flex items-center gap-1">
            <span className="w-5 h-5 rounded-full bg-primary/30 flex items-center justify-center text-[10px] font-medium">
              {task.assignee.fullName?.charAt(0).toUpperCase() || "?"}
            </span>
            <span>{task.assignee.fullName || task.assignee.username}</span>
          </span>
        </div>
      )}
    </div>
  );
}
