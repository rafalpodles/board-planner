"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { ApiTask, ApiProject, STATUS_LABELS } from "@/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TaskForm } from "@/components/tasks/TaskForm";
import { Comments } from "@/components/tasks/Comments";

export default function TaskDetailPage() {
  const { projectId, taskId } = useParams<{
    projectId: string;
    taskId: string;
  }>();
  const router = useRouter();
  const api = useApi();

  const [task, setTask] = useState<ApiTask | null>(null);
  const [project, setProject] = useState<ApiProject | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(true);

  async function loadData() {
    try {
      const [t, p] = await Promise.all([
        api.get(`/api/projects/${projectId}/tasks/${taskId}`),
        api.get(`/api/projects/${projectId}`),
      ]);
      setTask(t);
      setProject(p);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.del(`/api/projects/${projectId}/tasks/${taskId}`);
      router.push(`/projects/${projectId}`);
    } catch (err) {
      console.error(err);
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

  if (editing) {
    return (
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Edit Task</h1>
        <TaskForm
          projectId={projectId}
          task={task}
          components={project.components}
          onSaved={() => {
            setEditing(false);
            loadData();
          }}
          onCancel={() => setEditing(false)}
        />
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
            <Badge variant="status" value={task.status}>
              {STATUS_LABELS[task.status]}
            </Badge>
            <Badge variant="difficulty" value={task.difficulty}>
              {task.difficulty}
            </Badge>
            <Badge variant="category" value={task.category}>
              {task.category}
            </Badge>
          </div>
          <h1 className="text-2xl font-bold">{task.title}</h1>
        </div>

        {/* Meta */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
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
          <div>
            <span className="text-text-muted">Created: </span>
            <span>{new Date(task.createdAt).toLocaleDateString()}</span>
          </div>
        </div>

        {/* Description */}
        {task.description && (
          <div>
            <h2 className="font-semibold mb-2">Description</h2>
            <p className="text-sm whitespace-pre-wrap text-text-muted">
              {task.description}
            </p>
          </div>
        )}

        {/* Acceptance Criteria */}
        {task.acceptanceCriteria && (
          <div>
            <h2 className="font-semibold mb-2">Acceptance Criteria</h2>
            <p className="text-sm whitespace-pre-wrap text-text-muted">
              {task.acceptanceCriteria}
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <Button size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>

        {/* Comments */}
        <div className="border-t border-border pt-6">
          <Comments projectId={projectId} taskId={taskId} />
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
