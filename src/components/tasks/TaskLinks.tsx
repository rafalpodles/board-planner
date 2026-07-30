"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { ApiTask, ApiTaskLink, DependencyType } from "@/types";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

const DEPENDENCY_LABELS: { value: DependencyType; label: string }[] = [
  { value: "blocked_by", label: "Blocked by" },
  { value: "relates", label: "Relates to" },
  { value: "duplicates", label: "Duplicates" },
];

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
  const [pickerType, setPickerType] = useState<DependencyType>("blocked_by");

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

  async function addLink(targetTaskId: string) {
    try {
      await api.post(`/api/projects/${projectId}/tasks/${task._id}/links`, {
        taskId: targetTaskId,
        type: pickerType,
      });
      toast("Dependency added", "success");
      setShowPicker(false);
      setSearch("");
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to add dependency", "error");
    }
  }

  async function removeLink(targetTaskId: string, type: DependencyType) {
    try {
      await api.del(`/api/projects/${projectId}/tasks/${task._id}/links`, {
        taskId: targetTaskId,
        type,
      });
      toast("Dependency removed", "success");
      onChanged();
    } catch {
      toast("Failed to remove dependency", "error");
    }
  }

  function navigateToTask(taskId: string) {
    router.push(`/projects/${projectId}/tasks/${taskId}`);
  }

  const blockedBy = task.blockedBy || [];
  const blocking = task.blocking || [];
  const relations = task.relations || [];
  const relatedFrom = task.relatedFrom || [];
  const relatesTo = [
    ...relations.filter((r) => r.type === "relates"),
    // "relates" is symmetric, so an incoming link belongs in the same list
    ...relatedFrom.filter((r) => r.type === "relates"),
  ];
  const duplicates = relations.filter((r) => r.type === "duplicates");
  const duplicatedBy = relatedFrom.filter((r) => r.type === "duplicates");
  const linkedIds = new Set([
    ...blockedBy.map((t) => t._id),
    ...relations.map((r) => r.task._id),
  ]);

  const filteredTasks = allTasks.filter((t) => {
    if (linkedIds.has(t._id)) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      t.title.toLowerCase().includes(q) ||
      `${projectKey}-${t.taskNumber}`.toLowerCase().includes(q)
    );
  });

  const isEmpty =
    blockedBy.length === 0 &&
    blocking.length === 0 &&
    relatesTo.length === 0 &&
    duplicates.length === 0 &&
    duplicatedBy.length === 0;

  if (isEmpty && !showPicker) {
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
                  onClick={() => removeLink(t._id, "blocked_by")}
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

      {([
        { heading: "Relates to", items: relatesTo, removable: true, type: "relates" as DependencyType },
        { heading: "Duplicates", items: duplicates, removable: true, type: "duplicates" as DependencyType },
        { heading: "Duplicated by", items: duplicatedBy, removable: false, type: "duplicates" as DependencyType },
      ] as const).map((section) =>
        section.items.length === 0 ? null : (
          <div key={section.heading}>
            <h4 className="text-xs font-medium text-text-muted mb-1">{section.heading}</h4>
            <div className="space-y-1">
              {section.items.map((r) => (
                <div key={`${section.heading}-${r.task._id}`} className="flex items-center gap-2 text-sm group">
                  <button
                    onClick={() => navigateToTask(r.task._id)}
                    className="text-primary hover:underline font-mono text-xs"
                  >
                    {projectKey}-{r.task.taskNumber}
                  </button>
                  <span className="truncate flex-1">{r.task.title}</span>
                  <span className="text-xs text-text-muted">{r.task.status}</span>
                  {section.removable && (
                    <button
                      onClick={() => removeLink(r.task._id, section.type)}
                      className="text-text-muted hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity text-xs"
                    >
                      &times;
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )
      )}

      {showPicker ? (
        <div className="border border-border rounded-lg p-2 space-y-2">
          <select
            value={pickerType}
            onChange={(e) => setPickerType(e.target.value as DependencyType)}
            className="w-full bg-bg-input border border-border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
          >
            {DEPENDENCY_LABELS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
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
