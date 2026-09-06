"use client";

import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { subscribeBoardRefresh } from "@/lib/board-refresh";
import { taskPath } from "@/lib/urls";
import { duplicatePayload } from "@/lib/task-duplicate";
import { timeAgo } from "@/lib/time";
import { useAuth } from "@/hooks/use-auth";
import { ApiAgent, ApiProject, ApiSprint, ApiTask, ApiUserSummary, RunConflict } from "@/types";
import { useStore } from "@/app/(app)/agents/store";
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
import { MobileCommentBar } from "@/components/tasks/detail/MobileCommentBar";
import { MobileSummary } from "@/components/tasks/detail/MobileSummary";
import { PropertyRail } from "@/components/tasks/detail/PropertyRail";
import { assigneeToShow } from "@/components/tasks/detail/assignee-display";
import { TaskTopBar } from "@/components/tasks/detail/TaskTopBar";
import { useScrolledBehind } from "@/components/tasks/detail/atoms";
import { useTaskEditor } from "@/components/tasks/detail/useTaskEditor";
import type { Trigger } from "@/hooks/use-trigger-autocomplete";
import { useEditorTriggers } from "@/hooks/use-editor-triggers";
import { useOpenTask } from "@/hooks/use-open-task";

interface TaskDetailProps {
  projectId: string;
  taskId: string;
  onClose: () => void;
  onLoaded?: (task: ApiTask, project: ApiProject) => void;
}

export function TaskDetail({ projectId, taskId, onClose, onLoaded }: TaskDetailProps) {
  const api = useApi();
  const { toast } = useToast();

  const [task, setTask] = useState<ApiTask | null>(null);
  const [project, setProject] = useState<ApiProject | null>(null);
  const [sprints, setSprints] = useState<ApiSprint[]>([]);
  const { allAgents: agents } = useStore();
  const [users, setUsers] = useState<ApiUserSummary[]>([]);
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
      .get(`/api/projects/${projectId}/assignable-users`)
      .then(setUsers)
      .catch(() => setUsers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

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
      agents={agents}
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
  agents: ApiAgent[];
  users: ApiUserSummary[];
  onClose: () => void;
  onReload: () => void;
  onTaskChange: (updater: (prev: ApiTask | null) => ApiTask | null) => void;
}

function TaskDetailView({
  projectId,
  task,
  project,
  sprints,
  agents,
  users,
  onClose,
  onReload,
  onTaskChange,
}: TaskDetailViewProps) {
  const api = useApi();
  const openTask = useOpenTask();
  const { user: currentUser } = useAuth();
  const { toast } = useToast();

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [scrollBox, setScrollBox] = useState<HTMLElement | null>(null);
  const [titleBehindBar, watchTitle] = useScrolledBehind(scrollBox);
  const [heldStatus, setHeldStatus] = useState<{
    conflict: RunConflict;
    retry: () => Promise<unknown>;
  } | null>(null);
  const [heldDelete, setHeldDelete] = useState<RunConflict | null>(null);
  const [addingChild, setAddingChild] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [commentRefreshKey, setCommentRefreshKey] = useState(0);

  const { draft, set, autoSaveState, autoSaveError, retry, resend } = useTaskEditor(
    projectId,
    task
  );

  const columns = effectiveColumns(project.columns);
  const scope = { key: project.key, formerKeys: project.formerKeys };
  const triggers = useEditorTriggers(projectId, project.key);
  const taskKey = `${project.key}-${task.taskNumber}`;
  const assignee = assigneeToShow(users, draft.assignee, task.assignee);
  const reporter =
    task.createdBy && typeof task.createdBy === "object" ? task.createdBy.fullName : null;
  const watching = !!currentUser && (task.watchers || []).includes(currentUser._id);
  const projectDefaultAgent = project.worker?.agent ? String(project.worker.agent) : undefined;

  const repairAssigner = useCallback(
    async (username: string | null) => {
      await resend("assignee", username);
      onReload();
    },
    [resend, onReload]
  );

  const handleFileUpload = useCallback(
    async (file: File): Promise<string> => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("projectId", projectId);
      const result = await api.upload("/api/uploads", formData);
      return result.markdown;
    },
    [api, projectId]
  );

  async function handleStatusChange(status: string) {
    const patch = (force?: boolean) =>
      api.patch(`/api/projects/${projectId}/tasks/${task._id}/status`, {
        status,
        ...(force ? { force: true } : {}),
      });
    try {
      await patch();
      onReload();
    } catch (err) {
      const failure = err as { status?: number; body?: { runConflict?: RunConflict } };
      if (failure?.status === 409 && failure.body?.runConflict) {
        setHeldStatus({ conflict: failure.body.runConflict, retry: () => patch(true) });
        return;
      }
      toast("Failed to update status", "error");
    }
  }

  async function forceHeldStatus() {
    if (!heldStatus) return;
    const pending = heldStatus;
    setHeldStatus(null);
    try {
      await pending.retry();
      toast(`${taskKey} taken from the worker`, "success");
    } catch {
      toast("Failed to update status", "error");
    }
    onReload();
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
      const created = await api.post(`/api/projects/${projectId}/tasks`, duplicatePayload(task));
      toast("Task duplicated", "success");
      openTask(taskPath(projectId, created.taskNumber));
    } catch {
      toast("Failed to duplicate task", "error");
    }
  }

  async function handleDelete(force?: boolean) {
    setDeleting(true);
    try {
      await api.del(
        `/api/projects/${projectId}/tasks/${task._id}`,
        force ? { force: true } : undefined
      );
      toast("Task deleted", "success");
      onClose();
    } catch (err) {
      const failure = err as { status?: number; body?: { runConflict?: RunConflict } };
      if (failure?.status === 409 && failure.body?.runConflict) {
        setDeleting(false);
        setConfirmDelete(false);
        setHeldDelete(failure.body.runConflict);
        return;
      }
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
    <div className="flex min-h-0 flex-1 flex-col">
      <TaskTopBar
        projectName={project.name}
        projectRef={project.key}
        taskKey={taskKey}
        taskNumber={task.taskNumber}
        title={draft.title}
        showTitle={titleBehindBar}
        columns={columns}
        status={task.status}
        onStatusChange={handleStatusChange}
        watching={watching}
        watcherCount={(task.watchers || []).length}
        onToggleWatch={handleToggleWatch}
        onDuplicate={handleDuplicate}
        onAddChild={() => setAddingChild(true)}
        onDelete={requestDelete}
        onClose={onClose}
      />

      <div
        ref={setScrollBox}
        data-testid="task-scroll"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="grid lg:grid-cols-[minmax(0,1fr)_312px]">
          <div
            className="flex min-w-0 flex-col gap-6 px-4 py-6 pb-28 sm:px-7
              lg:border-r lg:border-border lg:pb-6"
          >
            <div className="flex flex-col gap-2">
              <div ref={watchTitle}>
                <InlineTitle value={draft.title} onChange={(value) => set("title", value)} />
              </div>
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
                <span
                  aria-live="polite"
                  className={autoSaveState === "saved" ? "text-success" : ""}
                >
                  {autoSaveState === "error" ? (
                    <button
                      type="button"
                      onClick={retry}
                      className="focus-ring rounded text-danger hover:underline"
                    >
                      ⚠ {autoSaveError || "Save failed"} — retry
                    </button>
                  ) : autoSaveState === "saving" ? (
                    "Saving…"
                  ) : (
                    "All changes saved"
                  )}
                </span>
              </div>
            </div>

            <MobileSummary
              draft={draft}
              assignee={assignee}
              categories={project.categories || []}
              onOpenDetails={() => setDetailsOpen(true)}
            />

            <DescriptionSection
              value={draft.description}
              onChange={(value) => set("description", value)}
              onFileUpload={handleFileUpload}
              scope={scope}
              triggers={triggers}
              collapsible
            />

            <CriteriaSection
              items={draft.checklist}
              triggers={triggers}
              scope={scope}
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
              <TaskActivityPanel
                projectId={projectId}
                taskId={task._id}
                scope={scope}
                commentRefreshKey={commentRefreshKey}
              />
            </section>
          </div>

          <aside className="hidden bg-bg px-5 py-6 lg:block">
            <PropertyRail
              draft={draft}
              set={set}
              users={users}
              sprints={sprints}
              agents={agents}
              projectId={String(project._id)}
              projectDefaultAgent={projectDefaultAgent}
              stored={task}
              columns={columns}
              onRepairAssigner={repairAssigner}
              currentUsername={currentUser?.username ?? null}
              categories={project.categories || []}
              customFields={project.customFields || []}
              reporter={reporter}
              onDelete={requestDelete}
            />
          </aside>
        </div>

        <MobileCommentBar
          projectId={projectId}
          projectKey={project.key}
          taskId={task._id}
          onPosted={() => setCommentRefreshKey((k) => k + 1)}
        />
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
          agents={agents}
          projectId={String(project._id)}
          projectDefaultAgent={projectDefaultAgent}
          stored={task}
          columns={columns}
          onRepairAssigner={repairAssigner}
          currentUsername={currentUser?.username ?? null}
          categories={project.categories || []}
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
        onConfirm={() => handleDelete()}
        title="Delete Task"
        message={`Are you sure you want to delete ${taskKey} "${task.title}"? This action cannot be undone.`}
        loading={deleting}
      />

      <ConfirmDialog
        open={!!heldDelete}
        onClose={() => setHeldDelete(null)}
        onConfirm={() => {
          setHeldDelete(null);
          return handleDelete(true);
        }}
        title="This task is being executed"
        message={
          heldDelete
            ? `${taskKey} is being executed by ${heldDelete.workerName || heldDelete.workerId || "a worker"} (phase ${heldDelete.phase}). Deleting it takes the task off that worker, and the task and its comments are gone for good.`
            : ""
        }
        confirmLabel="Delete anyway"
        loading={deleting}
      />

      <ConfirmDialog
        open={!!heldStatus}
        onClose={() => setHeldStatus(null)}
        onConfirm={forceHeldStatus}
        title="This task is being executed"
        message={
          heldStatus
            ? `${taskKey} is being executed by ${heldStatus.conflict.workerName || heldStatus.conflict.workerId || "a worker"} (phase ${heldStatus.conflict.phase}). Moving it takes the task off that worker and its work is lost.`
            : ""
        }
        confirmLabel="Move anyway"
      />
    </div>
  );
}
