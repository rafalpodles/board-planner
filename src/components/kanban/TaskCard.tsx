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
          {task.recurrence && (
            <svg className="w-3 h-3 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
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

      {task.linkedPRs && task.linkedPRs.length > 0 && (
        <div className="mb-2 flex items-center gap-1.5">
          {task.linkedPRs.map((pr) => (
            <span
              key={pr.number}
              className={`text-[10px] px-1.5 py-0.5 rounded font-medium inline-flex items-center gap-1 ${
                pr.state === "merged"
                  ? "text-[#8b5cf6] bg-[#8b5cf6]/10"
                  : pr.state === "open"
                    ? "text-[#22c55e] bg-[#22c55e]/10"
                    : "text-danger bg-danger/10"
              }`}
              title={pr.title}
            >
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
                {pr.state === "merged" ? (
                  <path d="M5.45 5.154A4.25 4.25 0 004.5 7.5h1.1a3.15 3.15 0 01.65-1.54l-.8-.806zM7.5 10.25a2.25 2.25 0 100-4.5 2.25 2.25 0 000 4.5zM12 7.5a4.25 4.25 0 01-.95 2.346l.8.806A5.35 5.35 0 0013.1 7.5H12zM8.55 10.846A4.25 4.25 0 017.5 11.1v1.1a5.35 5.35 0 001.854-.548l-.804-.806z" />
                ) : (
                  <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                )}
              </svg>
              #{pr.number}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between">
        {task.assignee && typeof task.assignee === "object" ? (
          <span className="text-xs text-text-muted flex items-center gap-1">
            <span className="w-5 h-5 rounded-full bg-primary/30 flex items-center justify-center text-[10px] font-medium">
              {task.assignee.fullName?.charAt(0).toUpperCase() || "?"}
            </span>
            <span>{task.assignee.fullName || task.assignee.username}</span>
          </span>
        ) : <span />}
        {task.dueDate && (() => {
          const due = new Date(task.dueDate);
          const now = new Date();
          now.setHours(0, 0, 0, 0);
          const diff = Math.ceil((due.getTime() - now.getTime()) / 86400000);
          const color = diff < 0 ? "text-danger" : diff <= 2 ? "text-warning" : "text-text-muted";
          return (
            <span className={`text-[10px] ${color} flex items-center gap-0.5`}>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              {due.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </span>
          );
        })()}
      </div>
    </div>
  );
}
