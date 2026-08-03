"use client";

import { useState, useEffect, type CSSProperties, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { ApiTask, ApiTaskLink, DependencyType } from "@/types";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { taskPath } from "@/lib/urls";

const DEPENDENCY_LABELS: { value: DependencyType; label: string }[] = [
  { value: "blocked_by", label: "Blocked by" },
  { value: "relates", label: "Relates to" },
  { value: "duplicates", label: "Duplicates" },
  { value: "parent_of", label: "Parent of" },
];

interface Column {
  id: string;
  label: string;
  color: string;
}

interface TaskLinksProps {
  projectId: string;
  projectKey: string;
  task: ApiTask;
  onChanged: () => void;
  /** The project's columns, so a linked task's status reads as its board label */
  columns?: Column[];
  /** Rendered beside "Add dependency" */
  actions?: ReactNode;
}

export function TaskLinks({
  projectId,
  projectKey,
  task,
  onChanged,
  columns = [],
  actions,
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

  function navigateToTask(taskNumber: number) {
    router.push(taskPath(projectId, taskNumber));
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
  const children = relations.filter((r) => r.type === "parent_of");
  const parents = relatedFrom.filter((r) => r.type === "parent_of");
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
    duplicatedBy.length === 0 &&
    children.length === 0 &&
    parents.length === 0;

  function statusChip(status: string) {
    const column = columns.find((c) => c.id === status);
    return (
      <span
        className="chip shrink-0 rounded px-2 py-0.5 text-[11px] font-medium"
        style={{ "--chip": column?.color || "var(--color-text-muted)" } as CSSProperties}
      >
        {column?.label || status}
      </span>
    );
  }

  if (isEmpty && !showPicker) {
    return (
      <div className="flex flex-wrap items-center gap-4">
        <AddDependencyButton onClick={() => setShowPicker(true)} />
        {actions}
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
          <div className="space-y-1.5">
            {blockedBy.map((t) => (
              <LinkRow
                key={t._id}
                taskKey={`${projectKey}-${t.taskNumber}`}
                title={t.title}
                status={statusChip(t.status)}
                onOpen={() => navigateToTask(t.taskNumber)}
                onRemove={() => removeLink(t._id, "blocked_by")}
              />
            ))}
          </div>
        </div>
      )}

      {blocking.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-text-muted mb-1">
            Is blocking
          </h4>
          <div className="space-y-1.5">
            {blocking.map((t) => (
              <LinkRow
                key={t._id}
                taskKey={`${projectKey}-${t.taskNumber}`}
                title={t.title}
                status={statusChip(t.status)}
                onOpen={() => navigateToTask(t.taskNumber)}
              />
            ))}
          </div>
        </div>
      )}

      {([
        { heading: "Relates to", items: relatesTo, removable: true, type: "relates" as DependencyType },
        { heading: "Duplicates", items: duplicates, removable: true, type: "duplicates" as DependencyType },
        { heading: "Duplicated by", items: duplicatedBy, removable: false, type: "duplicates" as DependencyType },
        { heading: "Children", items: children, removable: true, type: "parent_of" as DependencyType },
        { heading: "Parent", items: parents, removable: false, type: "parent_of" as DependencyType },
      ] as const).map((section) =>
        section.items.length === 0 ? null : (
          <div key={section.heading}>
            <h4 className="text-xs font-medium text-text-muted mb-1">{section.heading}</h4>
            <div className="space-y-1.5">
              {section.items.map((r) => (
                <LinkRow
                  key={`${section.heading}-${r.task._id}`}
                  taskKey={`${projectKey}-${r.task.taskNumber}`}
                  title={r.task.title}
                  status={statusChip(r.task.status)}
                  onOpen={() => navigateToTask(r.task.taskNumber)}
                  onRemove={
                    section.removable
                      ? () => removeLink(r.task._id, section.type)
                      : undefined
                  }
                />
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
        <div className="flex flex-wrap items-center gap-4">
          <AddDependencyButton onClick={() => setShowPicker(true)} />
          {actions}
        </div>
      )}
    </div>
  );
}

function AddDependencyButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring rounded text-sm text-text-muted transition-colors hover:text-text"
    >
      + Add dependency
    </button>
  );
}

interface LinkRowProps {
  taskKey: string;
  title: string;
  status: ReactNode;
  onOpen: () => void;
  onRemove?: () => void;
}

function LinkRow({ taskKey, title, status, onOpen, onRemove }: LinkRowProps) {
  return (
    <div className="group flex items-center gap-3 rounded-lg border border-border bg-bg-input/40 px-3 py-2.5 text-sm">
      <button
        type="button"
        onClick={onOpen}
        className="focus-ring shrink-0 rounded font-mono text-xs text-primary hover:underline"
      >
        {taskKey}
      </button>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {status}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Unlink ${taskKey}`}
          className="focus-ring shrink-0 rounded px-1 text-text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
        >
          &times;
        </button>
      )}
    </div>
  );
}
