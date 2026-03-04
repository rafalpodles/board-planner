"use client";

import { useEffect, useRef, useState } from "react";
import { ApiTask, STATUS_LABELS, TASK_STATUSES, TaskStatus } from "@/types";
import { Badge } from "@/components/ui/Badge";

type SortKey = "taskNumber" | "title" | "status" | "assignee" | "difficulty" | "category" | "component" | "dueDate" | "updatedAt";

interface ListViewProps {
  tasks: ApiTask[];
  projectKey: string;
  focusedIndex?: number;
  onTaskClick: (taskId: string) => void;
  onStatusChange?: (taskId: string, status: string) => void;
}

const DIFFICULTY_ORDER: Record<string, number> = { S: 0, M: 1, L: 2, XL: 3 };
const STATUS_ORDER: Record<string, number> = Object.fromEntries(
  TASK_STATUSES.map((s, i) => [s, i])
);

export function ListView({ tasks, projectKey, focusedIndex = -1, onTaskClick, onStatusChange }: ListViewProps) {
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("taskNumber");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

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

  function sortedTasks() {
    const sorted = [...tasks].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "taskNumber":
          cmp = a.taskNumber - b.taskNumber;
          break;
        case "title":
          cmp = a.title.localeCompare(b.title);
          break;
        case "status":
          cmp = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
          break;
        case "assignee": {
          const aName = a.assignee && typeof a.assignee === "object" ? a.assignee.fullName : "";
          const bName = b.assignee && typeof b.assignee === "object" ? b.assignee.fullName : "";
          cmp = aName.localeCompare(bName);
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
    return sorted;
  }

  function timeAgo(dateStr: string) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function SortHeader({ label, column, className }: { label: string; column: SortKey; className?: string }) {
    const active = sortKey === column;
    return (
      <th
        className={`text-left px-3 py-2 font-medium cursor-pointer select-none hover:text-text transition-colors ${className || ""}`}
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

  const sorted = sortedTasks();

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-bg-input text-text-muted text-xs border-b border-border">
              <SortHeader label="Key" column="taskNumber" />
              <SortHeader label="Title" column="title" />
              <SortHeader label="Status" column="status" className="hidden sm:table-cell" />
              <SortHeader label="Assignee" column="assignee" className="hidden md:table-cell" />
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

              return (
                <tr
                  key={task._id}
                  ref={(el) => { rowRefs.current[index] = el; }}
                  onClick={() => onTaskClick(task._id)}
                  className={`border-b border-border last:border-b-0 hover:bg-bg-input/50 cursor-pointer transition-colors ${
                    index === focusedIndex ? "ring-2 ring-primary ring-inset bg-primary/5" : ""
                  }`}
                >
                  <td className="px-3 py-2 font-mono text-xs text-text-muted whitespace-nowrap">
                    {task.pinned && (
                      <svg className="w-3 h-3 text-primary inline mr-1" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2z"/>
                      </svg>
                    )}
                    {projectKey}-{task.taskNumber}
                  </td>
                  <td className="px-3 py-2 font-medium truncate max-w-[300px]">
                    {task.title}
                  </td>
                  <td className="px-3 py-2 hidden sm:table-cell">
                    {onStatusChange ? (
                      <select
                        value={task.status}
                        onChange={(e) => {
                          e.stopPropagation();
                          onStatusChange(task._id, e.target.value);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="text-xs bg-bg-input border border-border rounded px-1.5 py-1 text-text focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
                      >
                        {TASK_STATUSES.map((s: TaskStatus) => (
                          <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                        ))}
                      </select>
                    ) : (
                      <Badge variant="status" value={task.status}>
                        {STATUS_LABELS[task.status]}
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 hidden md:table-cell text-text-muted">
                    {task.assignee && typeof task.assignee === "object"
                      ? task.assignee.fullName
                      : "—"}
                  </td>
                  <td className="px-3 py-2 hidden lg:table-cell">
                    <Badge variant="difficulty" value={task.difficulty}>
                      {task.difficulty}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 hidden lg:table-cell">
                    <Badge variant="category" value={task.category}>
                      {task.category}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 hidden xl:table-cell text-text-muted">
                    {task.component || "—"}
                  </td>
                  <td className={`px-3 py-2 hidden md:table-cell text-xs whitespace-nowrap ${dueDateInfo?.color || "text-text-muted"}`}>
                    {dueDateInfo?.formatted || "—"}
                  </td>
                  <td className="px-3 py-2 hidden sm:table-cell text-text-muted text-xs whitespace-nowrap">
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
