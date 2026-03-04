"use client";

import { ApiTask, STATUS_LABELS, TASK_STATUSES, TaskStatus } from "@/types";
import { Badge } from "@/components/ui/Badge";

interface ListViewProps {
  tasks: ApiTask[];
  projectKey: string;
  onTaskClick: (taskId: string) => void;
  onStatusChange?: (taskId: string, status: string) => void;
}

export function ListView({ tasks, projectKey, onTaskClick, onStatusChange }: ListViewProps) {
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

  if (tasks.length === 0) {
    return null;
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-bg-input text-text-muted text-xs border-b border-border">
            <th className="text-left px-3 py-2 font-medium">Key</th>
            <th className="text-left px-3 py-2 font-medium">Title</th>
            <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">Status</th>
            <th className="text-left px-3 py-2 font-medium hidden md:table-cell">Assignee</th>
            <th className="text-left px-3 py-2 font-medium hidden lg:table-cell">Difficulty</th>
            <th className="text-left px-3 py-2 font-medium hidden lg:table-cell">Category</th>
            <th className="text-left px-3 py-2 font-medium hidden xl:table-cell">Component</th>
            <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">Updated</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr
              key={task._id}
              onClick={() => onTaskClick(task._id)}
              className="border-b border-border last:border-b-0 hover:bg-bg-input/50 cursor-pointer transition-colors"
            >
              <td className="px-3 py-2 font-mono text-xs text-text-muted whitespace-nowrap">
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
              <td className="px-3 py-2 hidden sm:table-cell text-text-muted text-xs whitespace-nowrap">
                {timeAgo(task.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
