"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { subscribeBoardRefresh } from "@/lib/board-refresh";
import { taskPath } from "@/lib/urls";
import { useAuth } from "@/hooks/use-auth";
import { ApiTask, ApiProject, ApiSprint } from "@/types";
import { effectiveColumns } from "@/lib/columns";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { TaskForm } from "@/components/tasks/TaskForm";
import { TaskActivityPanel } from "@/components/tasks/TaskActivityPanel";
import { ResizableSplit } from "@/components/tasks/ResizableSplit";
import { TaskLinks } from "@/components/tasks/TaskLinks";
import { useToast } from "@/components/ui/Toast";
import { GitlabActivity } from "@/components/tasks/GitlabActivity";

interface TaskDetailProps {
  projectId: string;
  taskId: string;
  /** Back to the board: the page navigates, the modal just closes */
  onClose: () => void;
  /** Only the page needs it; the modal has its own dismiss */
  showBackLink?: boolean;
  onLoaded?: (task: ApiTask, project: ApiProject) => void;
}

export function TaskDetail({
  projectId,
  taskId,
  onClose,
  showBackLink = false,
  onLoaded,
}: TaskDetailProps) {
  const router = useRouter();
  const api = useApi();
  const { user: currentUser } = useAuth();
  const { toast } = useToast();

  const [task, setTask] = useState<ApiTask | null>(null);
  const [project, setProject] = useState<ApiProject | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sprints, setSprints] = useState<ApiSprint[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const [t, p, s] = await Promise.all([
        api.get(`/api/projects/${projectId}/tasks/${taskId}`),
        api.get(`/api/projects/${projectId}`),
        api.get(`/api/projects/${projectId}/sprints`),
      ]);
      setTask(t);
      setProject(p);
      setSprints(s);
      onLoaded?.(t, p);
    } catch {
      toast("Failed to load task", "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, taskId]);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // The board was not the only view going stale on a PM write — this page never reloaded
  // at all, so the form kept editing a task that had moved underneath it
  useEffect(() => subscribeBoardRefresh(projectId, loadData), [projectId, loadData]);

  async function handleStatusChange(newStatus: string) {
    try {
      await api.patch(
        `/api/projects/${projectId}/tasks/${taskId}/status`,
        { status: newStatus }
      );
      setTask((prev) =>
        prev ? { ...prev, status: newStatus as ApiTask["status"] } : prev
      );
    } catch {
      toast("Failed to update status", "error");
    }
  }

  async function handleDuplicate() {
    try {
      const created = await api.post(`/api/projects/${projectId}/tasks`, {
        title: `Copy of ${task!.title}`,
        description: task!.description,
        difficulty: task!.difficulty,
        category: task!.category,
        component: task!.component,
        checklist: task!.checklist,
        dueDate: task!.dueDate,
        status: "planned",
      });
      toast("Task duplicated", "success");
      router.push(taskPath(projectId, created.taskNumber));
    } catch {
      toast("Failed to duplicate task", "error");
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.del(`/api/projects/${projectId}/tasks/${taskId}`);
      toast("Task deleted", "success");
      onClose();
    } catch {
      toast("Failed to delete task", "error");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (loading || !task || !project) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      {showBackLink && (
        <button
          onClick={onClose}
          className="mb-4 flex min-h-[44px] items-center text-sm text-text-muted transition-colors hover:text-text"
        >
          &larr; Back to board
        </button>
      )}

      <ResizableSplit
        asideLabel="activity"
        aside={<TaskActivityPanel projectId={projectId} taskId={taskId} />}
      >
      <>
        {/* Header */}
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="font-mono text-text-muted">
              {project.key}-{task.taskNumber}
            </span>
            <select
              value={task.status}
              onChange={(e) => handleStatusChange(e.target.value)}
              className="text-xs font-medium bg-bg-input border border-border rounded px-2 py-1 text-text focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
            >
              {effectiveColumns(project.columns).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <button
              onClick={async () => {
                try {
                  const res = await api.post(
                    `/api/projects/${projectId}/tasks/${taskId}/watch`,
                    {}
                  );
                  setTask((prev) => {
                    if (!prev || !currentUser) return prev;
                    const watchers = res.watching
                      ? [...(prev.watchers || []), currentUser._id]
                      : (prev.watchers || []).filter((w: string) => w !== currentUser._id);
                    return { ...prev, watchers };
                  });
                  toast(res.watching ? "Watching task" : "Unwatched task", "success");
                } catch {
                  toast("Failed to toggle watch", "error");
                }
              }}
              className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                currentUser && (task.watchers || []).includes(currentUser._id)
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-text-muted hover:text-text hover:border-border"
              }`}
              title={
                currentUser && (task.watchers || []).includes(currentUser._id)
                  ? "Stop watching"
                  : "Watch for changes"
              }
            >
              {currentUser && (task.watchers || []).includes(currentUser._id)
                ? "Watching"
                : "Watch"}
              {(task.watchers || []).length > 0 && (
                <span className="ml-1 opacity-60">({(task.watchers || []).length})</span>
              )}
            </button>
          </div>
        </div>

        <TaskForm
          projectId={projectId}
          projectKey={project.key}
          task={task}
          components={project.components}
          categories={(project.categories || []).map((c) => c.name)}
          columns={project.columns || []}
          sprints={sprints}
          customFields={project.customFields || []}
          onSaved={loadData}
          onCancel={onClose}
        />

        {/* Linked PRs */}
        {task.linkedPRs && task.linkedPRs.length > 0 && (
          <div>
            <h2 className="font-semibold mb-2">Pull / Merge Requests</h2>
            <div className="space-y-1.5">
              {task.linkedPRs.map((pr) => (
                <a
                  key={`${pr.provider ?? "github"}-${pr.number}`}
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm hover:bg-bg-hover px-2 py-1.5 rounded transition-colors"
                >
                  <svg
                    className={`w-4 h-4 shrink-0 ${
                      pr.state === "merged"
                        ? "text-[#8b5cf6]"
                        : pr.state === "open"
                          ? "text-[#22c55e]"
                          : "text-danger"
                    }`}
                    fill="currentColor"
                    viewBox="0 0 16 16"
                  >
                    <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                  </svg>
                  <span className="flex-1 truncate">
                    #{pr.number} {pr.title}
                  </span>
                  {pr.provider === "gitlab" && (
                    <span
                      className="chip chip-custom text-[11px] px-1.5 py-0.5 rounded font-medium"
                      style={{ "--chip": "#fc6d26" } as CSSProperties}
                    >
                      GitLab
                    </span>
                  )}
                  <span
                    className="chip chip-custom text-[11px] px-1.5 py-0.5 rounded font-medium"
                    style={
                      {
                        "--chip":
                          pr.state === "merged"
                            ? "#8b5cf6"
                            : pr.state === "open"
                              ? "var(--color-success)"
                              : "var(--color-danger)",
                      } as CSSProperties
                    }
                  >
                    {pr.state}
                  </span>
                </a>
              ))}
            </div>
          </div>
        )}

        <GitlabActivity projectId={projectId} taskId={taskId} />

        {/* Dependencies */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold">Dependencies</h2>
            <Button size="sm" variant="secondary" onClick={() => setAddingChild(true)}>
              Add child
            </Button>
          </div>
          <TaskLinks
            projectId={projectId}
            projectKey={project.key}
            task={task}
            onChanged={loadData}
          />
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <Button size="sm" variant="secondary" onClick={handleDuplicate}>
            Duplicate
          </Button>
          <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>

      </>
      </ResizableSplit>

      <Modal
        open={addingChild}
        onClose={() => setAddingChild(false)}
        title={`New child of ${project.key}-${task.taskNumber}`}
        size="lg"
      >
        <TaskForm
          projectId={projectId}
          projectKey={project.key}
          parentTaskId={task._id}
          components={project.components}
          categories={(project.categories || []).map((c) => c.name)}
          columns={project.columns || []}
          projectLabels={project.labels || []}
          sprints={sprints}
          customFields={project.customFields || []}
          onSaved={() => {
            setAddingChild(false);
            loadData();
          }}
          onCancel={() => setAddingChild(false)}
        />
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
        title="Delete Task"
        message={`Are you sure you want to delete ${project.key}-${task.taskNumber} "${task.title}"? This action cannot be undone.`}
        loading={deleting}
      />
    </div>
  );
}
