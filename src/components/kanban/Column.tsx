"use client";

import { useState } from "react";
import { ApiTask, ApiLabel, ApiCustomField, ApiProjectCategory } from "@/types";
import { AnyColumn } from "@/lib/columns";
import { TaskCard } from "./TaskCard";

interface ColumnProps {
  column: AnyColumn;
  tasks: ApiTask[];
  projectKey: string;
  customFields?: ApiCustomField[];
  projectCategories?: ApiProjectCategory[];
  selectedTasks?: Set<string>;
  selectionMode?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onDragOverColumn?: (over: boolean) => void;
  onStatusChange: (taskId: string, status: string) => void;
  onTaskDrop?: (taskId: string, status: string, dropIndex: number) => void;
  onTaskClick: (taskId: string) => void;
  onTaskSelect?: (taskId: string) => void;
  onTaskContextMenu?: (taskId: string, x: number, y: number) => void;
}

export function Column({
  column,
  tasks,
  projectKey,
  customFields,
  projectCategories,
  selectedTasks,
  selectionMode,
  collapsed = false,
  onToggleCollapsed,
  onDragOverColumn,
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
        onDragOverColumn?.(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsDragOver(false);
          setDropIndex(null);
          onDragOverColumn?.(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        onDragOverColumn?.(false);
        const taskId = e.dataTransfer.getData("text/plain");
        if (taskId) {
          if (onTaskDrop && dropIndex !== null) {
            onTaskDrop(taskId, column.id, dropIndex);
          } else {
            onStatusChange(taskId, column.id);
          }
        }
        setDropIndex(null);
      }}
      onClick={collapsed ? onToggleCollapsed : undefined}
      // The rail has to stay a div — it is also the drop target — so it borrows
      // a button's keyboard contract rather than becoming one
      role={collapsed ? "button" : undefined}
      tabIndex={collapsed ? 0 : undefined}
      aria-label={collapsed ? `Expand ${column.label}` : undefined}
      onKeyDown={
        collapsed
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggleCollapsed?.();
              }
            }
          : undefined
      }
      title={collapsed ? `${column.label} — 0 tasks. Click to expand.` : undefined}
      // Addressable by id rather than by its heading text: an e2e test otherwise has to find the
      // label and walk back up the tree, which breaks on any markup change
      data-testid={`column-${column.id}`}
      className={`bg-bg-card rounded-xl border border-border
        border-t-2 flex flex-col max-h-[calc(100vh-12rem)] lg:max-h-full lg:h-full lg:min-h-0
        transition-colors ${isDragOver ? "bg-primary/5 border-primary/30" : ""}
        ${collapsed ? "focus-ring items-center gap-2.5 py-2.5 cursor-pointer hover:bg-bg-hover" : ""}`}
      style={{ borderTopColor: column.color }}
    >
      {collapsed ? (
        <>
          <span className="rounded-full bg-bg-input px-2 py-0.5 text-xs text-text-muted">
            {tasks.length}
          </span>
          <span className="min-h-0 flex-1 truncate text-[12px] font-semibold text-text-muted [writing-mode:vertical-rl]">
            {column.label}
          </span>
          <svg
            className="h-3.5 w-3.5 shrink-0 text-text-muted"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </>
      ) : (
      <>
      <div className="px-3 py-2.5 flex items-center justify-between gap-1.5 border-b border-border">
        <h3 className="min-w-0 truncate text-sm font-medium">{column.label}</h3>
        <div className="flex shrink-0 items-center gap-1">
          <span className="text-xs text-text-muted bg-bg-input rounded-full px-2 py-0.5">
            {tasks.length}
          </span>
          {/* Only an empty column can return to the rail, so only it offers the way back */}
          {tasks.length === 0 && onToggleCollapsed && (
            <button
              type="button"
              onClick={onToggleCollapsed}
              title={`Collapse ${column.label}`}
              aria-label={`Collapse ${column.label}`}
              className="focus-ring rounded p-0.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
        </div>
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
                customFields={customFields}
                projectCategories={projectCategories}
                selected={selectedTasks?.has(task._id)}
                selectionActive={selectionMode || (selectedTasks?.size ?? 0) > 0}
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
          <p className="text-xs text-text-muted text-center py-6">
            Drop tasks here
          </p>
        )}
      </div>
      </>
      )}
    </div>
  );
}
