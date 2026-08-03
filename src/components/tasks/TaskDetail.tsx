"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { subscribeBoardRefresh } from "@/lib/board-refresh";
import { taskPath } from "@/lib/urls";
import { timeAgo } from "@/lib/time";
import { useAuth } from "@/hooks/use-auth";
import { ApiProject, ApiSprint, ApiTask, ApiUser } from "@/types";
import { effectiveColumns } from "@/lib/columns";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { TaskForm } from "@/components/tasks/TaskForm";
import { TaskActivityPanel } from "@/components/tasks/TaskActivityPanel";
import { ExecutionPanel } from "@/components/tasks/ExecutionPanel";
import { useToast } from "@/components/ui/Toast";
import { GitlabActivity } from "@/components/tasks/GitlabActivity";
import { CriteriaSection } from "@/components/tasks/detail/CriteriaSection";
import { DescriptionSection } from "@/components/tasks/detail/DescriptionSection";
import { InlineTitle } from "@/components/tasks/detail/InlineTitle";
import { LinkedWork } from "@/components/tasks/detail/LinkedWork";
import { MobileSummary } from "@/components/tasks/detail/MobileSummary";
import { PropertyRail } from "@/components/tasks/detail/PropertyRail";
import { TaskTopBar } from "@/components/tasks/detail/TaskTopBar";
import { useTaskEditor } from "@/components/tasks/detail/useTaskEditor";

interface TaskDetailProps {
  projectId: string;
  taskId: string;
  /** Back to the board: the page navigates, the modal just closes */
  onClose: () => void;
  onLoaded?: (task: ApiTask, project: ApiProject) => void;
}

export function TaskDetail({ projectId, taskId, onClose, onLoaded }: TaskDetailProps) {
  const api = useApi();
  const { toast } = useToast();

  const [task, setTask] = useState<ApiTask | null>(null);
  const [project, setProject] = useState<ApiProject | null>(null);
  const [sprints, setSprints] = useState<ApiSprint[]>([]);
  const [users, setUsers] = useState<ApiUser[]>([]);
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

  useEffect(() => {
    api
      .get("/api/users")
      .then(setUsers)
      .catch(() => setUsers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The board was not the only view going stale on a PM write — this view never reloaded
  // at all, so it kept editing a task that had moved underneath it
  useEffect(() => subscribeBoardRefresh(projectId, loadData), [projectId, loadData]);

  if (loading || !task || !project) {
    return (
      <div className="flex justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <TaskDetailView
      key={task._id}
      projectId={projectId}
      task={task}
      project={project}
      sprints={sprints}
      users={users}
      onClose={onClose}
      onReload={loadData}
      onTaskChange={setTask}
    />
  );
}

interface TaskDetailViewProps {
  projectId: string;
  task: ApiTask;
  project: ApiProject;
  sprints: ApiSprint[];
  users: ApiUser[];
  onClose: () => void;
  onReload: () => void;
  onTaskChange: (updater: (prev: ApiTask | null) => ApiTask | null) => void;
}

function TaskDetailView({
  projectId,
  task,
  project,
  sprints,
  users,
  onClose,
  onReload,
  onTaskChange,
}: TaskDetailViewProps) {
  const api = useApi();
  const router = useRouter();
  const { user: currentUser } = useAuth();
  const { toast } = useToast();

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const { draft, set, autoSaveState, retry } = useTaskEditor(projectId, task);

  const columns = effectiveColumns(project.columns);
  const taskKey = `${project.key}-${task.taskNumber}`;
  const assignee = users.find((u) => u.username === draft.assignee);
  const reporter = typeof task.createdBy === "object" ? task.createdBy.fullName : null;
  const watching = !!currentUser && (task.watchers || []).includes(currentUser._id);

  const handleFileUpload = useCallback(
    async (file: File): Promise<string> => {
      const formData = new FormData();
      formData.append("file", file);
      const result = await api.upload("/api/uploads", formData);
      return result.markdown;
    },
    [api]
  );

  async function handleStatusChange(status: string) {
    try {
      await api.patch(`/api/projects/${projectId}/tasks/${task._id}/status`, { status });
      // A status change ends any run the task was under, and the server clears the execution phase
      // in the same write — so patching status alone would leave the panel asserting a live run the
      // user just stopped, counting up from a snapshot that is no longer true
      onReload();
    } catch {
      toast("Failed to update status", "error");
    }
  }

  async function handleToggleWatch() {
    try {
      const res = await api.post(`/api/projects/${projectId}/tasks/${task._id}/watch`, {});
      onTaskChange((prev) => {
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
  }

  async function handleDuplicate() {
    try {
      const created = await api.post(`/api/projects/${projectId}/tasks`, {
        title: `Copy of ${task.title}`,
        description: task.description,
        category: task.category,
        checklist: task.checklist,
        dueDate: task.dueDate,
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
      await api.del(`/api/projects/${projectId}/tasks/${task._id}`);
      toast("Task deleted", "success");
      onClose();
    } catch {
      toast("Failed to delete task", "error");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  function requestDelete() {
    setDetailsOpen(false);
    setConfirmDelete(true);
  }

  return (
    <div className="flex min-h-0 flex-col">
      <TaskTopBar
        projectName={project.name}
        taskKey={taskKey}
        columns={columns}
        status={task.status}
        onStatusChange={handleStatusChange}
        watching={watching}
        watcherCount={(task.watchers || []).length}
        onToggleWatch={handleToggleWatch}
        onDuplicate={handleDuplicate}
        onAddChild={() => setAddingChild(true)}
        onClose={onClose}
      />

      <div className="grid lg:grid-cols-[minmax(0,1fr)_312px]">
        <div className="flex min-w-0 flex-col gap-6 px-4 py-6 sm:px-7 lg:border-r lg:border-border">
          <div className="flex flex-col gap-2">
            <InlineTitle value={draft.title} onChange={(value) => set("title", value)} />
            <div className="flex flex-wrap items-center gap-2 px-1.5 text-xs text-text-muted">
              <span>
                Created{" "}
                {new Date(task.createdAt).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                })}
                {reporter ? ` by ${reporter}` : ""}
              </span>
              <span aria-hidden className="opacity-40">
                •
              </span>
              <span>Edited {timeAgo(task.updatedAt)}</span>
              <span aria-hidden className="opacity-40">
                •
              </span>
              {autoSaveState === "error" ? (
                <button
                  type="button"
                  onClick={retry}
                  className="focus-ring rounded text-danger hover:underline"
                >
                  ⚠ Save failed — retry
                </button>
              ) : (
                <span
                  aria-live="polite"
                  className={autoSaveState === "saved" ? "text-success" : ""}
                >
                  {autoSaveState === "saving" ? "Saving…" : "All changes saved"}
                </span>
              )}
            </div>
          </div>

          <MobileSummary
            draft={draft}
            assignee={assignee}
            onOpenDetails={() => setDetailsOpen(true)}
          />

          <DescriptionSection
            value={draft.description}
            onChange={(value) => set("description", value)}
            onFileUpload={handleFileUpload}
            collapsible
          />

          <CriteriaSection
            items={draft.checklist}
            onChange={(items) => set("checklist", items)}
          />

          <ExecutionPanel execution={task.execution} />

          <LinkedWork
            projectId={projectId}
            projectKey={project.key}
            task={task}
            columns={columns}
            onChanged={onReload}
            onAddChild={() => setAddingChild(true)}
          />

          <GitlabActivity projectId={projectId} taskId={task._id} />

          <section className="border-t border-border pt-5">
            <TaskActivityPanel projectId={projectId} taskId={task._id} />
          </section>
        </div>

        <aside className="hidden bg-bg px-5 py-6 lg:block">
          <PropertyRail
            draft={draft}
            set={set}
            users={users}
            sprints={sprints}
            categories={(project.categories || []).map((c) => c.name)}
            customFields={project.customFields || []}
            reporter={reporter}
            onDelete={requestDelete}
          />
        </aside>
      </div>

      <Modal
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        title="All details"
        size="md"
      >
        <PropertyRail
          draft={draft}
          set={set}
          users={users}
          sprints={sprints}
          categories={(project.categories || []).map((c) => c.name)}
          customFields={project.customFields || []}
          reporter={reporter}
          onDelete={requestDelete}
          touch
        />
      </Modal>

      <Modal
        open={addingChild}
        onClose={() => setAddingChild(false)}
        title={`New child of ${taskKey}`}
        size="lg"
      >
        <TaskForm
          projectId={projectId}
          projectKey={project.key}
          parentTaskId={task._id}
          categories={(project.categories || []).map((c) => c.name)}
          columns={project.columns || []}
          sprints={sprints}
          customFields={project.customFields || []}
          onSaved={() => {
            setAddingChild(false);
            onReload();
          }}
          onCancel={() => setAddingChild(false)}
        />
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
        title="Delete Task"
        message={`Are you sure you want to delete ${taskKey} "${task.title}"? This action cannot be undone.`}
        loading={deleting}
      />
    </div>
  );
}
