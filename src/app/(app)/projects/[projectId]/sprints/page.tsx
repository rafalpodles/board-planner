"use client";

import { useEffect, useState } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { ApiSprint, ApiTask } from "@/types";
import { columnIdsWithRole } from "@/lib/columns";
import { resolveEstimateField, sumEstimates } from "@/lib/estimates";
import { useProjectBoard } from "@/hooks/use-project-board";
import { ProjectBoardView } from "@/components/kanban/ProjectBoardView";
import { resolveSelectedSprint } from "@/lib/sprint-selection";
import { SprintSelector } from "@/components/sprints/SprintSelector";
import { SprintHeader } from "@/components/sprints/SprintHeader";
import { PlanningView } from "@/components/sprints/PlanningView";
import { VelocityChart } from "@/components/sprints/VelocityChart";
import { SprintFormModal, SprintFormValues } from "@/components/sprints/SprintFormModal";
import { CompleteSprintDialog } from "@/components/sprints/CompleteSprintDialog";
import { NewTaskModal } from "@/components/tasks/NewTaskModal";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { PageHeader } from "@/components/shell/PageHeader";

function Spinner() {
  return (
    <div className="flex justify-center py-12" role="status" aria-label="Loading sprint">
      <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
    </div>
  );
}

export default function SprintsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const api = useApi();
  const { toast } = useToast();

  const requested = searchParams.get("sprint");
  const requestedView = searchParams.get("view") === "planning" ? "planning" : "board";

  const [scope, setScope] = useState<string | null>(null);
  const board = useProjectBoard(projectId, scope);

  const [editing, setEditing] = useState<ApiSprint | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [completing, setCompleting] = useState<ApiSprint | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ApiSprint | null>(null);
  const [deletingSprint, setDeletingSprint] = useState(false);
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const [showVelocity, setShowVelocity] = useState(false);
  const [planningTasks, setPlanningTasks] = useState<ApiTask[] | null>(null);
  const [planningTasksScope, setPlanningTasksScope] = useState<string | null>(null);
  if (planningTasksScope !== scope) {
    setPlanningTasksScope(scope);
    setPlanningTasks(null);
  }

  useEffect(() => {
    if (board.loading) return;
    if (pathname !== `/projects/${projectId}/sprints`) return;
    const next = resolveSelectedSprint(board.sprints, requested);
    if (next !== scope) setScope(next);
    if (next && next !== requested) {
      const suffix = requestedView === "planning" ? "&view=planning" : "";
      router.replace(`/projects/${projectId}/sprints?sprint=${next}${suffix}`);
    }
  }, [board.loading, board.sprints, requested, requestedView, scope, projectId, router, pathname]);

  function openForm(sprint: ApiSprint | null) {
    setEditing(sprint);
    setShowForm(true);
  }

  async function handleSubmit(values: SprintFormValues) {
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/api/projects/${projectId}/sprints/${editing._id}`, values);
        toast("Sprint updated", "success");
      } else {
        await api.post(`/api/projects/${projectId}/sprints`, values);
        toast("Sprint created", "success");
      }
      setShowForm(false);
      board.reload();
    } catch {
      toast("Failed to save sprint", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleActivate(sprintId: string) {
    try {
      await api.put(`/api/projects/${projectId}/sprints/${sprintId}`, { status: "active" });
      toast("Sprint activated", "success");
      board.reload();
    } catch {
      toast("Failed to activate sprint", "error");
    }
  }

  async function handleComplete(sprintId: string, moveToBacklog: boolean) {
    try {
      await api.put(`/api/projects/${projectId}/sprints/${sprintId}`, {
        status: "completed",
        moveIncompleteToBacklog: moveToBacklog,
      });
      toast("Sprint completed", "success");
      setCompleting(null);
      board.reload();
    } catch {
      toast("Failed to complete sprint", "error");
    }
  }

  async function handleDelete(sprintId: string) {
    setDeletingSprint(true);
    try {
      await api.del(`/api/projects/${projectId}/sprints/${sprintId}`);
      toast("Sprint deleted", "success");
      board.reload();
    } catch {
      toast("Failed to delete sprint", "error");
    } finally {
      setDeletingSprint(false);
      setConfirmDelete(null);
    }
  }

  function sprintUrl(sprintId: string, targetView: "board" | "planning"): string {
    const suffix = targetView === "planning" ? "&view=planning" : "";
    return `/projects/${projectId}/sprints?sprint=${sprintId}${suffix}`;
  }

  const selected = scope ? board.sprints.find((s) => s._id === scope) ?? null : null;
  const sprintIsReadOnly = selected?.status === "completed";
  const view = !sprintIsReadOnly && requestedView === "planning" ? "planning" : "board";
  const tasksLoaded = scope !== null && board.loadedScope === scope;
  const doneIds = new Set(columnIdsWithRole(board.project, "done"));
  const doneCount =
    view === "planning" && planningTasks
      ? planningTasks.filter((t) => doneIds.has(t.status)).length
      : tasksLoaded
        ? board.tasks.filter((t) => doneIds.has(t.status)).length
        : selected?.doneCount ?? 0;
  const totalCount =
    view === "planning" && planningTasks
      ? planningTasks.length
      : tasksLoaded
        ? board.tasks.length
        : selected?.taskCount ?? 0;
  const estimateField = resolveEstimateField(board.project);
  const estimateFieldId = estimateField?._id ?? "";
  const hasCompletedSprint = board.sprints.some((s) => s.status === "completed");
  const canShowVelocity = !!estimateField && hasCompletedSprint;
  const estimateTotal =
    view === "planning" && planningTasks
      ? sumEstimates(planningTasks, estimateFieldId)
      : tasksLoaded
        ? sumEstimates(board.tasks, estimateFieldId)
        : selected?.estimateTotal ?? 0;
  const estimateDone =
    view === "planning" && planningTasks
      ? sumEstimates(planningTasks.filter((t) => doneIds.has(t.status)), estimateFieldId)
      : tasksLoaded
        ? sumEstimates(board.tasks.filter((t) => doneIds.has(t.status)), estimateFieldId)
        : selected?.estimateDone ?? 0;
  const estimate = estimateField
    ? { total: estimateTotal, done: estimateDone, label: estimateField.name }
    : undefined;

  useEffect(() => {
    if (initialLoadDone || !board.project) return;
    if (board.sprints.length === 0 || tasksLoaded) setInitialLoadDone(true);
  }, [initialLoadDone, board.project, board.sprints.length, tasksLoaded]);

  if (board.loading || (!board.project && !board.loadError)) return <Spinner />;

  if (!board.project) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <p className="text-sm text-text-muted">Failed to load this board.</p>
        <Button size="sm" onClick={board.reload}>
          Retry
        </Button>
      </div>
    );
  }

  if (!initialLoadDone) return <Spinner />;

  return (
    <div className="lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:overflow-hidden">
      <PageHeader
        title="Sprints"
        subtitle={
          board.sprints.length === 1 ? "1 sprint" : `${board.sprints.length} sprints`
        }
        actions={
          <div className="flex gap-2">
            {selected && !sprintIsReadOnly && (
              <Button size="sm" variant="secondary" onClick={() => board.setShowNewTask(true)}>
                Create Task
              </Button>
            )}
            {canShowVelocity && (
              <Button size="sm" variant="secondary" onClick={() => setShowVelocity(true)}>
                Velocity
              </Button>
            )}
            <Button size="sm" onClick={() => openForm(null)}>
              New Sprint
            </Button>
          </div>
        }
      />

      {board.sprints.length === 0 ? (
        <div className="py-16 text-center">
          <p className="mb-4 text-text-muted">No sprints yet</p>
          <Button size="sm" onClick={() => openForm(null)}>
            Create your first sprint
          </Button>
        </div>
      ) : (
        <div className="lg:flex lg:min-h-0 lg:flex-1 lg:gap-5 lg:overflow-hidden">
          <SprintSelector
            sprints={board.sprints}
            selectedId={scope}
            onSelect={(id) => router.push(sprintUrl(id, view))}
          />
          <div className="min-w-0 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:overflow-hidden">
            {selected ? (
              <>
                <SprintHeader
                  sprint={selected}
                  sprints={board.sprints}
                  doneCount={doneCount}
                  totalCount={totalCount}
                  canMeasureDone={doneIds.size > 0}
                  estimate={estimate}
                  readOnly={sprintIsReadOnly}
                  view={view}
                  onViewChange={(next) => router.push(sprintUrl(selected._id, next))}
                  onActivate={() => handleActivate(selected._id)}
                  onComplete={() => setCompleting(selected)}
                  onEdit={() => openForm(selected)}
                  onDelete={() => setConfirmDelete(selected)}
                  onSelectSprint={(id) => router.push(sprintUrl(id, view))}
                />
                {view === "planning" ? (
                  <>
                    <PlanningView
                      projectId={projectId}
                      board={board}
                      sprintId={selected._id}
                      onTasksChange={setPlanningTasks}
                    />
                    <NewTaskModal
                      projectId={projectId}
                      project={board.project}
                      sprints={board.sprints}
                      scope={scope}
                      open={board.showNewTask}
                      onClose={() => board.setShowNewTask(false)}
                      onSaved={() => {
                        board.setShowNewTask(false);
                        board.reload();
                      }}
                    />
                  </>
                ) : (
                  <ProjectBoardView
                    board={board}
                    readOnly={sprintIsReadOnly}
                    pinViewMode="board"
                    emptyState={
                      <div className="flex flex-col items-center justify-center py-16 text-center">
                        <h2 className="text-lg font-medium text-text-muted mb-2">
                          No tasks in this sprint
                        </h2>
                      </div>
                    }
                  />
                )}
              </>
            ) : (
              <Spinner />
            )}
          </div>
        </div>
      )}

      {showVelocity && (
        <Modal open onClose={() => setShowVelocity(false)} title="Velocity">
          <VelocityChart sprints={board.sprints} />
        </Modal>
      )}

      {showForm && (
        <SprintFormModal
          sprints={board.sprints}
          editing={editing}
          saving={saving}
          onSubmit={handleSubmit}
          onClose={() => setShowForm(false)}
        />
      )}

      {completing && (
        <CompleteSprintDialog
          sprint={completing}
          onComplete={(moveToBacklog) => handleComplete(completing._id, moveToBacklog)}
          onClose={() => setCompleting(null)}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && handleDelete(confirmDelete._id)}
        title="Delete Sprint"
        message="Are you sure? Tasks in this sprint will be moved to backlog."
        confirmLabel="Delete"
        loading={deletingSprint}
      />
    </div>
  );
}
