"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { ApiTask, ApiProject, ApiSprint, ApiLabel, TASK_STATUSES, STATUS_LABELS } from "@/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TaskForm } from "@/components/tasks/TaskForm";
import { Comments } from "@/components/tasks/Comments";
import { TaskLinks } from "@/components/tasks/TaskLinks";
import { useToast } from "@/components/ui/Toast";
import { ActivityTimeline } from "@/components/tasks/ActivityTimeline";

export default function TaskDetailPage() {
  const { projectId, taskId } = useParams<{
    projectId: string;
    taskId: string;
  }>();
  const router = useRouter();
  const api = useApi();
  const { user: currentUser } = useAuth();
  const { toast } = useToast();

  const [task, setTask] = useState<ApiTask | null>(null);
  const [project, setProject] = useState<ApiProject | null>(null);
  const [editing, setEditing] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sprints, setSprints] = useState<ApiSprint[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadData() {
    try {
      const [t, p, s] = await Promise.all([
        api.get(`/api/projects/${projectId}/tasks/${taskId}`),
        api.get(`/api/projects/${projectId}`),
        api.get(`/api/projects/${projectId}/sprints`),
      ]);
      setTask(t);
      setProject(p);
      setSprints(s);
    } catch {
      toast("Failed to load task", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  useEffect(() => {
    if (!editing) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setEditing(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [editing]);

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
      router.push(`/projects/${projectId}/tasks/${created._id}`);
    } catch {
      toast("Failed to duplicate task", "error");
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.del(`/api/projects/${projectId}/tasks/${taskId}`);
      toast("Task deleted", "success");
      router.push(`/projects/${projectId}`);
    } catch {
      toast("Failed to delete task", "error");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  const markdownComponents = {
    img: ({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={alt || ""}
        {...props}
        className="rounded-lg max-w-full h-auto border border-border"
        loading="lazy"
      />
    ),
  };

  if (loading || !task || !project) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <button
        onClick={() => router.push(`/projects/${projectId}`)}
        className="text-sm text-text-muted hover:text-text mb-4 inline-block min-h-[44px] flex items-center"
      >
        &larr; Back to board
      </button>

      <div className="space-y-6">
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
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
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

        {editing ? (
          <TaskForm
            projectId={projectId}
            projectKey={project.key}
            task={task}
            components={project.components}
            projectLabels={project.labels || []}
            sprints={sprints}
            onSaved={() => {
              setEditing(false);
              loadData();
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            <h1 className="text-2xl font-bold">{task.title}</h1>

            {/* Meta */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div className="flex gap-2">
                <Badge variant="difficulty" value={task.difficulty}>
                  {task.difficulty}
                </Badge>
                <Badge variant="category" value={task.category}>
                  {task.category}
                </Badge>
              </div>
              {task.component && (
                <div>
                  <span className="text-text-muted">Component: </span>
                  <span>{task.component}</span>
                </div>
              )}
              {task.assignee && typeof task.assignee === "object" && (
                <div>
                  <span className="text-text-muted">Assignee: </span>
                  <span>{task.assignee.fullName}</span>
                </div>
              )}
              {task.dueDate && (() => {
                const due = new Date(task.dueDate);
                const now = new Date();
                now.setHours(0, 0, 0, 0);
                const diff = Math.ceil((due.getTime() - now.getTime()) / 86400000);
                const color = diff < 0 ? "text-danger" : diff <= 2 ? "text-warning" : "text-text";
                return (
                  <div>
                    <span className="text-text-muted">Due: </span>
                    <span className={color}>
                      {due.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                      {diff < 0 && " (overdue)"}
                    </span>
                  </div>
                );
              })()}
              {task.recurrence && (
                <div>
                  <span className="text-text-muted">Repeats: </span>
                  <span>
                    Every {task.recurrence.interval > 1 ? `${task.recurrence.interval} ` : ""}
                    {task.recurrence.frequency === "daily" ? (task.recurrence.interval > 1 ? "days" : "day") :
                     task.recurrence.frequency === "weekly" ? (task.recurrence.interval > 1 ? "weeks" : "week") :
                     (task.recurrence.interval > 1 ? "months" : "month")}
                  </span>
                </div>
              )}
              <div>
                <span className="text-text-muted">Created: </span>
                <span>{new Date(task.createdAt).toLocaleDateString()}</span>
              </div>
            </div>

            {/* Labels */}
            {(() => {
              const taskLabels = (project.labels || []).filter((l: ApiLabel) =>
                (task.labels || []).includes(l._id)
              );
              return taskLabels.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {taskLabels.map((label: ApiLabel) => (
                    <span
                      key={label._id}
                      className="text-xs px-2 py-0.5 rounded-full text-white font-medium"
                      style={{ backgroundColor: label.color }}
                    >
                      {label.name}
                    </span>
                  ))}
                </div>
              ) : null;
            })()}

            {/* Description */}
            {task.description && (
              <div>
                <h2 className="font-semibold mb-2">Description</h2>
                <div className="text-sm text-text-muted prose prose-invert prose-sm max-w-none overflow-x-auto">
                  <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{task.description}</Markdown>
                </div>
              </div>
            )}

            {/* Checklist */}
            {task.checklist && task.checklist.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <h2 className="font-semibold">Checklist</h2>
                  <span className="text-xs text-text-muted">
                    {task.checklist.filter((i) => i.done).length}/{task.checklist.length}
                  </span>
                </div>
                <div className="space-y-1">
                  {task.checklist.map((item) => (
                    <label
                      key={item._id}
                      className="flex items-center gap-2 text-sm cursor-pointer group"
                    >
                      <input
                        type="checkbox"
                        checked={item.done}
                        onChange={async () => {
                          // Optimistic update
                          setTask((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  checklist: prev.checklist.map((i) =>
                                    i._id === item._id
                                      ? { ...i, done: !i.done }
                                      : i
                                  ),
                                }
                              : prev
                          );
                          try {
                            await api.put(
                              `/api/projects/${projectId}/tasks/${taskId}/checklist`,
                              { itemId: item._id, done: !item.done }
                            );
                          } catch {
                            loadData();
                            toast("Failed to update checklist", "error");
                          }
                        }}
                        className="rounded border-border"
                      />
                      <span
                        className={
                          item.done
                            ? "line-through text-text-muted"
                            : "text-text"
                        }
                      >
                        {item.text}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Linked PRs */}
        {task.linkedPRs && task.linkedPRs.length > 0 && (
          <div>
            <h2 className="font-semibold mb-2">Pull Requests</h2>
            <div className="space-y-1.5">
              {task.linkedPRs.map((pr) => (
                <a
                  key={pr.number}
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
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                      pr.state === "merged"
                        ? "text-[#8b5cf6] bg-[#8b5cf6]/10"
                        : pr.state === "open"
                          ? "text-[#22c55e] bg-[#22c55e]/10"
                          : "text-danger bg-danger/10"
                    }`}
                  >
                    {pr.state}
                  </span>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Dependencies */}
        <div>
          <h2 className="font-semibold mb-2">Dependencies</h2>
          <TaskLinks
            projectId={projectId}
            projectKey={project.key}
            task={task}
            onChanged={loadData}
          />
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          {!editing && (
            <Button size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={handleDuplicate}>
            Duplicate
          </Button>
          <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>

        {/* Comments */}
        <div className="border-t border-border pt-6">
          <Comments projectId={projectId} taskId={taskId} />
        </div>

        {/* Activity Log */}
        <div className="border-t border-border pt-6">
          <ActivityTimeline projectId={projectId} taskId={taskId} />
        </div>
      </div>

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
