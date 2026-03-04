"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { ApiNotification } from "@/types";
import { Button } from "@/components/ui/Button";

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const TYPE_LABELS: Record<string, string> = {
  task_assigned: "Assigned",
  status_changed: "Status changed",
  comment_added: "Comment",
  mentioned: "Mentioned",
};

export default function NotificationsPage() {
  const api = useApi();
  const router = useRouter();
  const [notifications, setNotifications] = useState<ApiNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);

  const loadNotifications = useCallback(
    async (before?: string) => {
      try {
        const url = before
          ? `/api/notifications?limit=30&before=${encodeURIComponent(before)}`
          : "/api/notifications?limit=30";
        const data: ApiNotification[] = await api.get(url);
        if (before) {
          setNotifications((prev) => [...prev, ...data]);
        } else {
          setNotifications(data);
        }
        setHasMore(data.length === 30);
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    },
    [api]
  );

  useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  async function markAllRead() {
    try {
      await api.patch("/api/notifications/read", {});
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    } catch {
      // silent
    }
  }

  async function handleClick(n: ApiNotification) {
    if (!n.read) {
      api.patch("/api/notifications/read", { id: n._id }).catch(() => {});
      setNotifications((prev) =>
        prev.map((item) => (item._id === n._id ? { ...item, read: true } : item))
      );
    }
    const projectId = typeof n.project === "object" ? n.project._id : n.project;
    const taskId = typeof n.task === "object" ? n.task._id : n.task;
    router.push(`/projects/${projectId}/tasks/${taskId}`);
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Notifications</h1>
        {notifications.some((n) => !n.read) && (
          <Button size="sm" variant="secondary" onClick={markAllRead}>
            Mark all as read
          </Button>
        )}
      </div>

      {notifications.length === 0 ? (
        <p className="text-text-muted text-center py-12">No notifications yet.</p>
      ) : (
        <div className="space-y-1">
          {notifications.map((n) => (
            <button
              key={n._id}
              onClick={() => handleClick(n)}
              className={`w-full text-left px-4 py-3 rounded-lg hover:bg-bg-hover transition-colors flex items-start gap-3 ${
                !n.read ? "bg-primary/5" : ""
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={`text-sm ${!n.read ? "font-medium text-text" : "text-text-muted"}`}>
                    {n.title}
                  </span>
                  {!n.read && <span className="w-2 h-2 rounded-full bg-primary shrink-0" />}
                </div>
                {n.body && (
                  <p className="text-xs text-text-muted truncate">{n.body}</p>
                )}
                <p className="text-xs text-text-muted mt-1">
                  <span className="inline-block bg-bg-input px-1.5 py-0.5 rounded text-[10px] mr-1.5">
                    {TYPE_LABELS[n.type] || n.type}
                  </span>
                  {typeof n.actor === "object" ? n.actor.fullName : ""}
                  {" \u00b7 "}
                  {timeAgo(n.createdAt)}
                  {typeof n.project === "object" && (
                    <span className="ml-1.5 opacity-60">{n.project.key}</span>
                  )}
                </p>
              </div>
            </button>
          ))}

          {hasMore && (
            <div className="text-center pt-4">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  const last = notifications[notifications.length - 1];
                  if (last) loadNotifications(last.createdAt);
                }}
              >
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
