"use client";

import { useEffect, useMemo, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { ApiTask } from "@/types";
import { ProjectBoard } from "@/hooks/use-project-board";
import { columnIdsWithRole } from "@/lib/columns";
import { resolveEstimateField, sumEstimates } from "@/lib/estimates";
import { useToast } from "@/components/ui/Toast";
import { PlanningPane } from "./PlanningPane";

interface PlanningViewProps {
  projectId: string;
  board: ProjectBoard;
  sprintId: string;
  // The sprint header's counts have nowhere else to read a task added from the backlog:
  // board.tasks never gains it (see the sprintOverlay note below), so this is the true list.
  onTasksChange?: (tasks: ApiTask[]) => void;
}

export function PlanningView({ projectId, board, sprintId, onTasksChange }: PlanningViewProps) {
  const api = useApi();
  const { toast } = useToast();
  const [backlog, setBacklog] = useState<ApiTask[]>([]);
  const [backlogLoading, setBacklogLoading] = useState(true);
  const [backlogError, setBacklogError] = useState(false);
  const [backlogReloadToken, setBacklogReloadToken] = useState(0);
  const [filter, setFilter] = useState("");
  // board.applySprintChange can only ever drop a task out of board.tasks, never add one in —
  // a task moved here from the backlog has nowhere else to live until the next poll catches up
  const [sprintOverlay, setSprintOverlay] = useState<ApiTask[]>([]);

  // Plain fetch into local state, not a second useProjectBoard — that would bring a second
  // 10s poll, a second held-move dialog and a second copy of every write handler for a list
  // that needs none of them.
  useEffect(() => {
    setBacklogLoading(true);
    setBacklogError(false);
    api
      .get(`/api/projects/${projectId}/tasks?sprint=backlog`)
      .then(setBacklog)
      .catch(() => setBacklogError(true))
      .finally(() => setBacklogLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, backlogReloadToken]);

  useEffect(() => {
    setSprintOverlay([]);
  }, [sprintId]);

  // board.tasks lags a scope change by one round trip (Task 6's forward note); rendering it
  // under the new sprint's name in the meantime is the bug Phase A already fixed once
  const tasksLoaded = board.loadedScope === sprintId;
  const sprintTasks = useMemo(
    () =>
      tasksLoaded
        ? [...board.tasks, ...sprintOverlay.filter((t) => !board.tasks.some((bt) => bt._id === t._id))]
        : [],
    [tasksLoaded, board.tasks, sprintOverlay]
  );

  // Reporting on every render — including the ones before tasksLoaded catches up with a
  // new sprintId — would hand the page an empty (but truthy) array it can't tell apart
  // from "this sprint genuinely has no tasks", flashing 0/0 over the fallback count.
  useEffect(() => {
    if (!tasksLoaded) return;
    onTasksChange?.(sprintTasks);
  }, [tasksLoaded, sprintTasks, onTasksChange]);

  function applyLocally(task: ApiTask, targetSprintId: string | null) {
    const moved = { ...task, sprint: targetSprintId };
    if (targetSprintId === sprintId) {
      setBacklog((prev) => prev.filter((t) => t._id !== task._id));
      setSprintOverlay((prev) => [...prev.filter((t) => t._id !== task._id), moved]);
    } else {
      setSprintOverlay((prev) => prev.filter((t) => t._id !== task._id));
      setBacklog((prev) => (prev.some((t) => t._id === task._id) ? prev : [...prev, moved]));
    }
    board.applySprintChange([task._id], targetSprintId);
  }

  async function move(task: ApiTask, targetSprintId: string | null) {
    applyLocally(task, targetSprintId);
    try {
      await api.put(`/api/projects/${projectId}/tasks/${task._id}`, { sprint: targetSprintId });
      // applySprintChange can drop a task out of board.tasks but never insert one, so a
      // task pulled in from the backlog only exists here until board.tasks catches up
      board.reload();
    } catch {
      applyLocally(task, targetSprintId === null ? sprintId : null);
      toast("Failed to move task", "error");
    }
  }

  function findTask(taskId: string): ApiTask | undefined {
    return backlog.find((t) => t._id === taskId) ?? sprintTasks.find((t) => t._id === taskId);
  }

  function dropInto(targetSprintId: string | null) {
    return (taskId: string) => {
      const task = findTask(taskId);
      if (task && (task.sprint ?? null) !== targetSprintId) move(task, targetSprintId);
    };
  }

  const doneIds = new Set(columnIdsWithRole(board.project, "done"));
  const query = filter.trim().toLowerCase();
  const visibleBacklog = backlog.filter((task) =>
    query ? task.title.toLowerCase().includes(query) : !doneIds.has(task.status)
  );

  const sprintName = board.sprints.find((s) => s._id === sprintId)?.name ?? "Sprint";
  const projectKey = board.project?.key ?? "";
  const estimateField = resolveEstimateField(board.project);
  const estimate = estimateField
    ? {
        total: sumEstimates(sprintTasks, estimateField._id),
        label: estimateField.name,
      }
    : undefined;

  return (
    <div className="lg:flex lg:min-h-0 lg:flex-1 lg:gap-5 lg:overflow-hidden">
      <div className="min-w-0 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter backlog"
          className="focus-ring mb-3 w-full shrink-0 rounded-lg border border-border bg-bg-input px-3 py-1.5 text-sm"
        />
        <PlanningPane
          title="Backlog"
          tasks={visibleBacklog}
          projectKey={projectKey}
          emptyMessage="No tasks in the backlog"
          action={{
            label: (task) => `Add ${task.title} to the sprint`,
            onClick: (task) => move(task, sprintId),
          }}
          actionIcon="add"
          onDropTask={dropInto(null)}
          loading={backlogLoading}
          error={backlogError}
          errorMessage="Couldn't load the backlog."
          onRetry={() => setBacklogReloadToken((n) => n + 1)}
          testId="planning-pane-backlog"
        />
      </div>
      <div className="min-w-0 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
        <PlanningPane
          title={sprintName}
          tasks={sprintTasks}
          projectKey={projectKey}
          emptyMessage="No tasks in this sprint"
          action={{
            label: (task) => `Remove ${task.title} from the sprint`,
            onClick: (task) => move(task, null),
          }}
          actionIcon="remove"
          onDropTask={tasksLoaded ? dropInto(sprintId) : undefined}
          loading={!tasksLoaded}
          estimate={estimate}
          testId="planning-pane-sprint"
        />
      </div>
    </div>
  );
}
