"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ApiProjectCategory, ApiProjectColumn, ApiSprint, ApiTask, PRIORITY_LABELS, PRIORITY_ORDER } from "@/types";
import { effectiveColumns } from "@/lib/columns";
import { Badge } from "@/components/ui/Badge";
import { categoryColor, categoryTint } from "@/lib/category-colors";
import { timeAgo } from "@/lib/time";

type SortKey = "taskNumber" | "title" | "status" | "assignee" | "priority" | "sprint" | "difficulty" | "category" | "component" | "dueDate" | "updatedAt";

interface ListViewProps {
  tasks: ApiTask[];
  projectKey: string;
  projectId?: string;
  sprints?: ApiSprint[];
  categories?: ApiProjectCategory[];
  columns?: ApiProjectColumn[];
  focusedIndex?: number;
  selectedTasks?: Set<string>;
  selectionMode?: boolean;
  onTaskClick: (taskId: string) => void;
  onStatusChange?: (taskId: string, status: string) => void;
  onTaskSelect?: (taskId: string) => void;
  onTaskContextMenu?: (taskId: string, x: number, y: number) => void;
}

function sprintTiming(sprint: ApiSprint): "active" | "past" | "upcoming" {
  const now = Date.now();
  const start = new Date(sprint.startDate).getTime();
  const end = new Date(sprint.endDate);
  end.setHours(23, 59, 59, 999);
  if (now > end.getTime()) return "past";
  if (now < start) return "upcoming";
  return "active";
}

const DIFFICULTY_ORDER: Record<string, number> = { S: 0, M: 1, L: 2, XL: 3 };

export function ListView({ tasks, projectKey, projectId, sprints = [], categories = [], columns, focusedIndex = -1, selectedTasks, selectionMode, onTaskClick, onStatusChange, onTaskSelect, onTaskContextMenu }: ListViewProps) {
  const selectionActive = selectionMode || (selectedTasks?.size ?? 0) > 0;
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("taskNumber");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const sprintById = useMemo(() => new Map(sprints.map((s) => [s._id, s])), [sprints]);
  const listColumns = useMemo(() => effectiveColumns(columns), [columns]);
  const columnById = useMemo(() => new Map(listColumns.map((c) => [c.id, c])), [listColumns]);
  const statusOrder = useMemo(
    () => new Map(listColumns.map((c, i) => [c.id, i])),
    [listColumns]
  );

  useEffect(() => {
    if (focusedIndex >= 0 && rowRefs.current[focusedIndex]) {
      rowRefs.current[focusedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [focusedIndex]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "updatedAt" || key === "dueDate" ? "desc" : "asc");
    }
  }

  const sorted = useMemo(() => {
    return [...tasks].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "taskNumber":
          cmp = a.taskNumber - b.taskNumber;
          break;
        case "title":
          cmp = a.title.localeCompare(b.title);
          break;
        case "status":
          cmp = (statusOrder.get(a.status) ?? 99) - (statusOrder.get(b.status) ?? 99);
          break;
        case "assignee": {
          const aName = a.assignee && typeof a.assignee === "object" ? a.assignee.fullName : "";
          const bName = b.assignee && typeof b.assignee === "object" ? b.assignee.fullName : "";
          cmp = aName.localeCompare(bName);
          break;
        }
        case "priority":
          cmp = (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
          break;
        case "sprint": {
          const start = (task: ApiTask) => {
            const sprint = task.sprint ? sprintById.get(task.sprint) : undefined;
            return sprint ? new Date(sprint.startDate).getTime() : Number.MAX_SAFE_INTEGER;
          };
          cmp = start(a) - start(b);
          break;
        }
        case "difficulty":
          cmp = (DIFFICULTY_ORDER[a.difficulty] ?? 99) - (DIFFICULTY_ORDER[b.difficulty] ?? 99);
          break;
        case "category":
          cmp = a.category.localeCompare(b.category);
          break;
        case "component":
          cmp = (a.component || "").localeCompare(b.component || "");
          break;
        case "dueDate": {
          const aDate = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
          const bDate = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
          cmp = aDate - bDate;
          break;
        }
        case "updatedAt":
          cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [tasks, sortKey, sortDir, sprintById, statusOrder]);

  function SortHeader({ label, column, className }: { label: string; column: SortKey; className?: string }) {
    const active = sortKey === column;
    return (
      <th
        className={`text-left px-2 py-2 font-medium cursor-pointer select-none hover:text-text transition-colors ${className || ""}`}
        onClick={() => handleSort(column)}
      >
        <span className="inline-flex items-center gap-0.5">
          {label}
          {active && (
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {sortDir === "asc" ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              )}
            </svg>
          )}
        </span>
      </th>
    );
  }

  if (tasks.length === 0) {
    return null;
  }


  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-bg-input text-text-muted text-xs border-b border-border">
              {selectionActive && <th className="w-8 px-2 py-2" />}
              <SortHeader label="Key" column="taskNumber" />
              <SortHeader label="Title" column="title" />
              <SortHeader label="Status" column="status" className="hidden sm:table-cell" />
              <SortHeader label="Assignee" column="assignee" className="hidden md:table-cell" />
              <SortHeader label="Priority" column="priority" className="hidden md:table-cell" />
              <SortHeader label="Sprint" column="sprint" className="hidden lg:table-cell" />
              <SortHeader label="Difficulty" column="difficulty" className="hidden lg:table-cell" />
              <SortHeader label="Category" column="category" className="hidden lg:table-cell" />
              <SortHeader label="Component" column="component" className="hidden xl:table-cell" />
              <SortHeader label="Due" column="dueDate" className="hidden md:table-cell" />
              <SortHeader label="Updated" column="updatedAt" className="hidden sm:table-cell" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((task, index) => {
              const dueDateInfo = task.dueDate ? (() => {
                const due = new Date(task.dueDate);
                const now = new Date();
                now.setHours(0, 0, 0, 0);
                const diff = Math.ceil((due.getTime() - now.getTime()) / 86400000);
                const color = diff < 0 ? "text-danger" : diff <= 2 ? "text-warning" : "text-text-muted";
                return { formatted: due.toLocaleDateString(undefined, { month: "short", day: "numeric" }), color };
              })() : null;

              const selected = selectedTasks?.has(task._id) ?? false;
              const catColor = categoryColor(categories, task.category);
              const tinted = !selected && index !== focusedIndex && !!catColor;
              const taskKey = `${projectKey}-${task.taskNumber}`;
              const statusLabel = columnById.get(task.status)?.label ?? task.status;
              const assigneeName =
                task.assignee && typeof task.assignee === "object" ? task.assignee.fullName : "—";

              return (
                <tr
                  key={task._id}
                  style={tinted ? categoryTint(catColor) : undefined}
                  ref={(el) => { rowRefs.current[index] = el; }}
                  onClick={(e) => {
                    if (selectionActive || e.ctrlKey || e.metaKey) {
                      e.preventDefault();
                      onTaskSelect?.(task._id);
                    } else {
                      onTaskClick(task._id);
                    }
                  }}
                  onContextMenu={(e) => {
                    if (!onTaskContextMenu) return;
                    e.preventDefault();
                    onTaskContextMenu(task._id, e.clientX, e.clientY);
                  }}
                  className={`border-b border-border last:border-b-0 cursor-pointer transition-colors ${
                    tinted ? "cat-row" : "hover:bg-bg-input/50"
                  } ${selected ? "bg-primary/10" : ""} ${
                    index === focusedIndex ? "ring-2 ring-primary ring-inset bg-primary/5" : ""
                  }`}
                >
                  {selectionActive && (
                    <td className="px-2 py-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onTaskSelect?.(task._id);
                        }}
                        className={`w-5 h-5 rounded border flex items-center justify-center transition-colors text-[10px]
                          ${selected
                            ? "bg-primary-solid border-primary text-white"
                            : "border-border bg-bg-input text-transparent hover:border-primary/50"
                          }`}
                      >
                        {selected && "✓"}
                      </button>
                    </td>
                  )}
                  <td
                    className="px-2 py-2 font-mono text-xs text-text-muted max-w-24"
                    title={taskKey}
                  >
                    <span className="flex items-center gap-1">
                      {task.pinned && (
                        <svg className="w-3 h-3 shrink-0 text-primary" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2z"/>
                        </svg>
                      )}
                      <span className="truncate">{taskKey}</span>
                    </span>
                  </td>
                  <td className="px-2 py-2 font-medium w-full max-w-0" title={task.title}>
                    <div className="truncate min-w-36 sm:min-w-48 lg:min-w-56 2xl:min-w-80">
                      {task.title}
                    </div>
                  </td>
                  <td className="px-2 py-2 hidden sm:table-cell">
                    {onStatusChange ? (
                      <select
                        value={task.status}
                        title={statusLabel}
                        aria-label={`Status for ${taskKey}: ${task.title}`}
                        onChange={(e) => {
                          e.stopPropagation();
                          onStatusChange(task._id, e.target.value);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="focus-ring text-xs bg-bg-input border border-border rounded px-1.5 py-1 max-w-28 text-text cursor-pointer"
                      >
                        {listColumns.map((c) => (
                          <option key={c.id} value={c.id}>{c.label}</option>
                        ))}
                      </select>
                    ) : (
                      <Badge
                        variant="status"
                        value={task.status}
                        color={columnById.get(task.status)?.color}
                        className="max-w-28"
                      >
                        <span className="truncate" title={statusLabel}>{statusLabel}</span>
                      </Badge>
                    )}
                  </td>
                  <td className="px-2 py-2 hidden md:table-cell text-text-muted max-w-32" title={assigneeName}>
                    <div className="truncate">{assigneeName}</div>
                  </td>
                  <td className="px-2 py-2 hidden md:table-cell">
                    <Badge variant="priority" value={task.priority}>
                      {PRIORITY_LABELS[task.priority] ?? task.priority}
                    </Badge>
                  </td>
                  <td className="px-2 py-2 hidden lg:table-cell text-xs max-w-32">
                    {(() => {
                      const sprint = task.sprint ? sprintById.get(task.sprint) : undefined;
                      if (!sprint) return <span className="text-text-muted">—</span>;
                      const timing = sprintTiming(sprint);
                      const inner = (
                        <span
                          className={`flex items-center gap-1.5 ${
                            timing === "active" ? "font-medium" : "text-text-muted"
                          }`}
                        >
                          {timing === "active" && (
                            <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                          )}
                          <span className="truncate" title={sprint.name}>{sprint.name}</span>
                        </span>
                      );
                      return projectId ? (
                        <Link
                          href={`/projects/${projectId}/sprints`}
                          onClick={(e) => e.stopPropagation()}
                          className="block hover:underline"
                        >
                          {inner}
                        </Link>
                      ) : (
                        inner
                      );
                    })()}
                  </td>
                  <td className="px-2 py-2 hidden lg:table-cell">
                    <Badge variant="difficulty" value={task.difficulty}>
                      {task.difficulty}
                    </Badge>
                  </td>
                  <td className="px-2 py-2 hidden lg:table-cell max-w-32">
                    <Badge
                      variant="category"
                      value={task.category}
                      color={catColor}
                      className="max-w-28"
                    >
                      <span className="truncate" title={task.category}>{task.category}</span>
                    </Badge>
                  </td>
                  <td
                    className="px-2 py-2 hidden xl:table-cell text-text-muted max-w-32"
                    title={task.component || undefined}
                  >
                    <div className="truncate">{task.component || "—"}</div>
                  </td>
                  <td className={`px-2 py-2 hidden md:table-cell text-xs max-w-24 ${dueDateInfo?.color || "text-text-muted"}`}>
                    <div className="truncate">{dueDateInfo?.formatted || "—"}</div>
                  </td>
                  <td className="px-2 py-2 hidden sm:table-cell text-text-muted text-xs whitespace-nowrap">
                    {timeAgo(task.updatedAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
