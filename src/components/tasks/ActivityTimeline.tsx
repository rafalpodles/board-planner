"use client";

import { useState, useEffect } from "react";
import { useApi } from "@/hooks/use-api";
import { ApiActivityLog, STATUS_LABELS, TaskStatus } from "@/types";

interface ActivityTimelineProps {
  projectId: string;
  taskId: string;
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function actionIcon(action: string) {
  switch (action) {
    case "created":
      return "+";
    case "status_changed":
      return "↔";
    case "updated":
      return "✎";
    case "comment_added":
      return "#";
    case "comment_edited":
      return "✎";
    case "comment_deleted":
      return "×";
    default:
      return "•";
  }
}

function actionColor(action: string) {
  switch (action) {
    case "created":
      return "text-success";
    case "status_changed":
      return "text-primary";
    case "comment_deleted":
      return "text-danger";
    default:
      return "text-text-muted";
  }
}

function formatFieldLabel(field: string): string {
  switch (field) {
    case "checklist":
      return "checklist";
    default:
      return field;
  }
}

function formatValue(field: string, value: string): string {
  if (field === "status" && value in STATUS_LABELS) {
    return STATUS_LABELS[value as TaskStatus];
  }
  if (!value) return "(empty)";
  if (value.length > 60) return value.slice(0, 60) + "…";
  return value;
}

function describeAction(log: ApiActivityLog): string {
  const userName =
    typeof log.user === "object" ? log.user.fullName : "Unknown";

  switch (log.action) {
    case "created":
      return `${userName} created this task`;
    case "status_changed":
      return `${userName} changed status from ${formatValue("status", log.oldValue)} to ${formatValue("status", log.newValue)}`;
    case "updated":
      if (log.field === "assignee") {
        const from = log.oldValue || "unassigned";
        const to = log.newValue || "unassigned";
        return `${userName} changed assignee from ${from} to ${to}`;
      }
      return `${userName} updated ${formatFieldLabel(log.field)}`;
    case "comment_added":
      return `${userName} added a comment`;
    case "comment_edited":
      return `${userName} edited a comment`;
    case "comment_deleted":
      return `${userName} deleted a comment`;
    default:
      return `${userName} performed an action`;
  }
}

export function ActivityTimeline({
  projectId,
  taskId,
}: ActivityTimelineProps) {
  const [logs, setLogs] = useState<ApiActivityLog[]>([]);
  const [expanded, setExpanded] = useState(false);
  const api = useApi();

  useEffect(() => {
    api
      .get(`/api/projects/${projectId}/tasks/${taskId}/activity`)
      .then((data: ApiActivityLog[]) => setLogs(data))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  if (logs.length === 0) return null;

  const displayLogs = expanded ? logs : logs.slice(0, 5);

  return (
    <div>
      <h3 className="font-semibold mb-3">
        Activity ({logs.length})
      </h3>

      <div className="space-y-2">
        {displayLogs.map((log) => (
          <div
            key={log._id}
            className="flex items-start gap-2 text-sm"
          >
            <span
              className={`flex-shrink-0 w-5 h-5 flex items-center justify-center text-xs rounded-full bg-bg-input ${actionColor(log.action)}`}
            >
              {actionIcon(log.action)}
            </span>
            <span className="flex-1 text-text-muted">
              {describeAction(log)}
            </span>
            <span className="flex-shrink-0 text-xs text-text-muted">
              {timeAgo(log.createdAt)}
            </span>
          </div>
        ))}
      </div>

      {logs.length > 5 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-primary hover:underline mt-2"
        >
          {expanded ? "Show less" : `Show all ${logs.length} entries`}
        </button>
      )}
    </div>
  );
}
