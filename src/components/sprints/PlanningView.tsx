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
  const [sprintOverlay, setSprintOverlay] = useState<ApiTask[]>([]);

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

  const tasksLoaded = board.loadedScope === sprintId;
  const sprintTasks = useMemo(
    () =>
      tasksLoaded
        ? [...board.tasks, ...sprintOverlay.filter((t) => !board.tasks.some((bt) => bt._id === t._id))]
        : [],
    [tasksLoaded, board.tasks, sprintOverlay]
  );

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
