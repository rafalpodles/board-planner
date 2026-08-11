"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { ApiSprint } from "@/types";
import { columnIdsWithRole } from "@/lib/columns";
import { useProjectBoard } from "@/hooks/use-project-board";
import { ProjectBoardView } from "@/components/kanban/ProjectBoardView";
import { resolveSelectedSprint } from "@/lib/sprint-selection";
import { SprintSelector } from "@/components/sprints/SprintSelector";
import { SprintHeader } from "@/components/sprints/SprintHeader";
import { SprintFormModal, SprintFormValues } from "@/components/sprints/SprintFormModal";
import { CompleteSprintDialog } from "@/components/sprints/CompleteSprintDialog";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { PageHeader } from "@/components/shell/PageHeader";

function Spinner() {
  return (
    <div className="flex justify-center py-12">
      <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
    </div>
  );
}

export default function SprintsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const api = useApi();
  const { toast } = useToast();

  const requested = searchParams.get("sprint");

  // Starts null on purpose: passing `requested` straight through would fire
  // /tasks?sprint=<unvalidated>, and that endpoint casts the value into a Mongoose filter
  // with no validation, so a stale bookmark is a 500 rather than a fallback.
  const [scope, setScope] = useState<string | null>(null);
  const board = useProjectBoard(projectId, scope);

  const [editing, setEditing] = useState<ApiSprint | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [completing, setCompleting] = useState<ApiSprint | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ApiSprint | null>(null);

  useEffect(() => {
    if (board.loading) return;
    const next = resolveSelectedSprint(board.sprints, requested);
    if (next !== scope) setScope(next);
    if (next && next !== requested) {
      router.replace(`/projects/${projectId}/sprints?sprint=${next}`);
    }
  }, [board.loading, board.sprints, requested, scope, projectId, router]);

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
    try {
      await api.del(`/api/projects/${projectId}/sprints/${sprintId}`);
      toast("Sprint deleted", "success");
      setConfirmDelete(null);
      board.reload();
    } catch {
      toast("Failed to delete sprint", "error");
    }
  }

  const selected = scope ? board.sprints.find((s) => s._id === scope) ?? null : null;
  // Until this sprint's own tasks are in, `board.tasks` still holds the sprint we came from,
  // and showing them under this name would be the page stating something untrue
  const tasksLoaded = scope !== null && board.loadedScope === scope;
  const doneIds = new Set(columnIdsWithRole(board.project, "done"));
  // The sprint list's own counts stand in meanwhile; after that the tasks are the truth, so
  // a filter on the board cannot move the sprint's progress
  const doneCount = tasksLoaded
    ? board.tasks.filter((t) => doneIds.has(t.status)).length
    : selected?.doneCount ?? 0;
  const totalCount = tasksLoaded ? board.tasks.length : selected?.taskCount ?? 0;

  if (board.loading || !board.project) return <Spinner />;

  return (
    <div className="lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:overflow-hidden">
      <PageHeader
        title="Sprints"
        subtitle={
          board.sprints.length === 1 ? "1 sprint" : `${board.sprints.length} sprints`
        }
        actions={
          <Button size="sm" onClick={() => openForm(null)}>
            New Sprint
          </Button>
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
            onSelect={(id) => router.push(`/projects/${projectId}/sprints?sprint=${id}`)}
          />
          <div className="min-w-0 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:overflow-hidden">
            {/* The hook reports loading:false while the sprint is still being resolved and
                again while its tasks are in flight, so the board waits for its own scope */}
            {selected ? (
              <>
                <SprintHeader
                  sprint={selected}
                  doneCount={doneCount}
                  totalCount={totalCount}
                  onActivate={() => handleActivate(selected._id)}
                  onComplete={() => setCompleting(selected)}
                  onEdit={() => openForm(selected)}
                  onDelete={() => setConfirmDelete(selected)}
                />
                {tasksLoaded ? (
                  <ProjectBoardView board={board} readOnly={selected.status === "completed"} />
                ) : (
                  <Spinner />
                )}
              </>
            ) : (
              <Spinner />
            )}
          </div>
        </div>
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
      />
    </div>
  );
}
