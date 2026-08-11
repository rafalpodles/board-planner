"use client";

import { useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { ApiTask } from "@/types";
import { ProjectBoard } from "@/hooks/use-project-board";
import { columnIdsWithRole } from "@/lib/columns";
import { PlanningPane } from "./PlanningPane";

interface PlanningViewProps {
  projectId: string;
  board: ProjectBoard;
  sprintId: string;
}

// TODO(BP-207): task 7 replaces this with real add/remove handlers and wires onDropTask
const NOOP_ACTION = { label: () => "", onClick: () => {} };

export function PlanningView({ projectId, board, sprintId }: PlanningViewProps) {
  const api = useApi();
  const [backlog, setBacklog] = useState<ApiTask[]>([]);
  const [filter, setFilter] = useState("");

  // Plain fetch into local state, not a second useProjectBoard — that would bring a second
  // 10s poll, a second held-move dialog and a second copy of every write handler for a list
  // that needs none of them.
  useEffect(() => {
    api
      .get(`/api/projects/${projectId}/tasks?sprint=backlog`)
      .then(setBacklog)
      .catch(() => setBacklog([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const doneIds = new Set(columnIdsWithRole(board.project, "done"));
  const query = filter.trim().toLowerCase();
  const visibleBacklog = backlog.filter((task) =>
    query ? task.title.toLowerCase().includes(query) : !doneIds.has(task.status)
  );

  const sprintName = board.sprints.find((s) => s._id === sprintId)?.name ?? "Sprint";
  const projectKey = board.project?.key ?? "";

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
          action={NOOP_ACTION}
        />
      </div>
      <div className="min-w-0 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
        <PlanningPane
          title={sprintName}
          tasks={board.tasks}
          projectKey={projectKey}
          emptyMessage="No tasks in this sprint"
          action={NOOP_ACTION}
        />
      </div>
    </div>
  );
}
