"use client";

import { useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ApiProject, ApiTask } from "@/types";
import { columnIdsWithRole } from "@/lib/columns";
import { useProjectBoard } from "@/hooks/use-project-board";
import { ProjectBoardView } from "@/components/kanban/ProjectBoardView";
import { useCanonicalUrl } from "@/hooks/use-canonical-url";
import { projectPath } from "@/lib/urls";
import { BoardHeader } from "@/components/kanban/BoardHeader";
import { sprintScopeFromParam, sprintScopeToQuery, isSprintScopeShape } from "@/lib/sprint-scope";
import { APP_NAME } from "@/lib/brand";
import { Button } from "@/components/ui/Button";

function useBoardDocumentTitle(project: ApiProject | null, tasks: ApiTask[]) {
  useEffect(() => {
    if (!project) return;
    // By role: a board that renamed these columns counted nothing and showed a bare project name
    const approved = new Set(columnIdsWithRole(project, "approved"));
    const active = new Set(columnIdsWithRole(project, "active"));
    const todoCount = tasks.filter((t) => approved.has(t.status)).length;
    const inProgressCount = tasks.filter((t) => active.has(t.status)).length;
    const parts: string[] = [];
    if (inProgressCount > 0) parts.push(`${inProgressCount} in progress`);
    if (todoCount > 0) parts.push(`${todoCount} todo`);
    const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    document.title = `${project.name}${suffix} — ${APP_NAME}`;
    return () => { document.title = APP_NAME; };
  }, [project, tasks]);
}

export default function KanbanPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Scope lives in the URL so it survives a reload and can be shared;
  // filters stay in localStorage
  const rawScope = searchParams.get("sprint");
  const scope = sprintScopeFromParam(rawScope);
  const board = useProjectBoard(projectId, scope);

  useEffect(() => {
    // A stale bookmark or a link to a deleted sprint falls back to the unscoped board;
    // leaving the bad value in the URL would just re-trigger the fallback every reload.
    // Native, not router.replace: this page sits under an @modal parallel route, and a
    // soft navigation risks waking it the way useCanonicalUrl already found out.
    const trimmed = rawScope?.trim();
    if (trimmed && !isSprintScopeShape(trimmed)) {
      window.history.replaceState(null, "", projectPath(projectId) + window.location.hash);
    }
  }, [rawScope, projectId]);

  useCanonicalUrl(board.project?.key);
  useBoardDocumentTitle(board.project, board.tasks);

  if (board.loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  // Nothing loaded and nothing to retry automatically: the poll already tried and
  // toasted once, so re-showing a spinner here would spin forever without ever
  // telling the person there is a problem to act on
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

  return (
    <div className="lg:flex-1 lg:min-h-0 lg:flex lg:flex-col lg:overflow-hidden">
      <BoardHeader
        projectName={board.project.name}
        projectIcon={board.project.icon}
        projectDescription={board.project.description}
        sprints={board.sprints}
        scope={scope}
        onScopeChange={(next) => router.push(projectPath(projectId) + sprintScopeToQuery(next))}
        viewMode={board.viewMode}
        onViewModeChange={board.setViewMode}
        onRefresh={board.reload}
        onNewTask={() => board.setShowNewTask(true)}
      />
      <ProjectBoardView board={board} />
    </div>
  );
}
