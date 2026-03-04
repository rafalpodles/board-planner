"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { ApiTask, ApiTaskLink } from "@/types";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

interface TaskLinksProps {
  projectId: string;
  projectKey: string;
  task: ApiTask;
  onChanged: () => void;
}

export function TaskLinks({
  projectId,
  projectKey,
  task,
  onChanged,
}: TaskLinksProps) {
  const api = useApi();
  const router = useRouter();
  const { toast } = useToast();
  const [allTasks, setAllTasks] = useState<ApiTaskLink[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!showPicker) return;
    api
      .get(`/api/projects/${projectId}/tasks`)
      .then((tasks: ApiTask[]) => {
        setAllTasks(
          tasks
            .filter((t) => t._id !== task._id)
            .map((t) => ({
              _id: t._id,
              taskNumber: t.taskNumber,
              title: t.title,
              status: t.status,
            }))
        );
      })
      .catch(() => toast("Failed to load tasks", "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPicker]);

  async function addLink(blockedByTaskId: string) {
    try {
      await api.post(
        `/api/projects/${projectId}/tasks/${task._id}/links`,
        { blockedByTaskId }
      );
      toast("Link added", "success");
      setShowPicker(false);
      setSearch("");
      onChanged();
    } catch {
      toast("Failed to add link", "error");
    }
  }

  async function removeLink(blockedByTaskId: string) {
    try {
      await api.del(
        `/api/projects/${projectId}/tasks/${task._id}/links`,
        { blockedByTaskId }
      );
      toast("Link removed", "success");
      onChanged();
    } catch {
      toast("Failed to remove link", "error");
    }
  }

  function navigateToTask(taskId: string) {
    router.push(`/projects/${projectId}/tasks/${taskId}`);
  }

  const blockedBy = task.blockedBy || [];
  const blocking = task.blocking || [];
  const existingIds = new Set(blockedBy.map((t) => t._id));

  const filteredTasks = allTasks.filter((t) => {
    if (existingIds.has(t._id)) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      t.title.toLowerCase().includes(q) ||
      `${projectKey}-${t.taskNumber}`.toLowerCase().includes(q)
    );
  });

  if (blockedBy.length === 0 && blocking.length === 0 && !showPicker) {
    return (
      <div>
        <button
          onClick={() => setShowPicker(true)}
          className="text-xs text-text-muted hover:text-primary transition-colors"
        >
          + Add dependency
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {blockedBy.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-text-muted mb-1">
            Blocked by
          </h4>
          <div className="space-y-1">
            {blockedBy.map((t) => (
              <div
                key={t._id}
                className="flex items-center gap-2 text-sm group"
              >
                <button
                  onClick={() => navigateToTask(t._id)}
                  className="text-primary hover:underline font-mono text-xs"
                >
                  {projectKey}-{t.taskNumber}
                </button>
                <span className="truncate flex-1">{t.title}</span>
                <span className="text-xs text-text-muted">{t.status}</span>
                <button
                  onClick={() => removeLink(t._id)}
                  className="text-text-muted hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity text-xs"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {blocking.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-text-muted mb-1">
            Is blocking
          </h4>
          <div className="space-y-1">
            {blocking.map((t) => (
              <div key={t._id} className="flex items-center gap-2 text-sm">
                <button
                  onClick={() => navigateToTask(t._id)}
                  className="text-primary hover:underline font-mono text-xs"
                >
                  {projectKey}-{t.taskNumber}
                </button>
                <span className="truncate flex-1">{t.title}</span>
                <span className="text-xs text-text-muted">{t.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {showPicker ? (
        <div className="border border-border rounded-lg p-2 space-y-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks..."
            className="w-full bg-bg-input border border-border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
          />
          <div className="max-h-40 overflow-y-auto space-y-1">
            {filteredTasks.map((t) => (
              <button
                key={t._id}
                onClick={() => addLink(t._id)}
                className="w-full text-left flex items-center gap-2 text-sm px-2 py-1 rounded hover:bg-bg-input transition-colors"
              >
                <span className="font-mono text-xs text-text-muted">
                  {projectKey}-{t.taskNumber}
                </span>
                <span className="truncate">{t.title}</span>
              </button>
            ))}
            {filteredTasks.length === 0 && (
              <p className="text-xs text-text-muted px-2 py-1">
                No tasks found
              </p>
            )}
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setShowPicker(false);
              setSearch("");
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <button
          onClick={() => setShowPicker(true)}
          className="text-xs text-text-muted hover:text-primary transition-colors"
        >
          + Add dependency
        </button>
      )}
    </div>
  );
}
