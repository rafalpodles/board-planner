"use client";

import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { ProjectBoard } from "@/hooks/use-project-board";
import { ApiTask, BOARD_SORT_FIELDS, LIST_SORT_FIELDS, SortKey, SortDir } from "@/types";
import { effectiveColumns } from "@/lib/columns";
import { ListColumnId } from "@/lib/list-columns";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Board } from "@/components/kanban/Board";
import { BoardFilters } from "@/components/kanban/BoardFilters";
import { TaskContextMenu } from "@/components/kanban/TaskContextMenu";
import { ListView } from "@/components/kanban/ListView";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { ShortcutHelp } from "@/components/ui/ShortcutHelp";
import { openLayerCount } from "@/lib/focus-trap";
import { taskPath } from "@/lib/urls";
import { NewTaskModal } from "@/components/tasks/NewTaskModal";

interface ProjectBoardViewProps {
  board: ProjectBoard;
  readOnly?: boolean;
  // Omit for the project's own default; pass null to render nothing instead
  emptyState?: ReactNode;
  // Overrides board.viewMode for this render and disables the "v" toggle. For a host
  // page that renders no view switcher of its own, so a stored "list" preference from
  // elsewhere can't strand it with no way back.
  pinViewMode?: "board" | "list";
}

export function ProjectBoardView({
  board,
  readOnly = false,
  emptyState,
  pinViewMode,
}: ProjectBoardViewProps) {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const api = useApi();
  const { user } = useAuth();
  const { toast } = useToast();

  const {
    project,
    tasks,
    sprints,
    assignableUsers,
    scope,
    loadedScope,
    viewMode: boardViewMode,
    setViewMode,
    showNewTask,
    setShowNewTask,
    selectedTasks,
    setSelectedTasks,
    selectionMode,
    setSelectionMode,
    confirmBulkDelete,
    setConfirmBulkDelete,
    bulkDeleting,
    confirmContextDelete,
    setConfirmContextDelete,
    deleting,
    heldMove,
    heldDelete,
    setHeldDelete,
    forceHeldDelete,
    setHeldMove,
    forceHeldMove,
    reload,
    applySprintChange,
    patchTask,
    handleStatusChange,
    handleTaskDrop,
    handleReorder,
    handleBulkMove,
    handleBulkSprint,
    handleBulkDelete,
    handleAssigneeChange,
    handleFieldValueChange,
    handleRowSprintChange,
    handleContextDuplicate,
    handleContextDelete,
  } = board;

  const viewMode = pinViewMode ?? boardViewMode;

  const [filteredTasks, setFilteredTasks] = useState<ApiTask[]>([]);
  const [contextMenu, setContextMenu] = useState<{ taskId: string; x: number; y: number } | null>(null);
  // One owner for both views: the filter bar's dropdown and the list's column
  // headers set the same value, and it survives switching between them
  const [sortField, setSortField] = useState<SortKey>("manual");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [hiddenColumns, setHiddenColumns] = useState<ListColumnId[]>([]);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [focusedTaskIndex, setFocusedTaskIndex] = useState(-1);

  const openTask = useCallback(
    (id: string) => {
      const task = tasks.find((t) => t._id === id);
      if (task) router.push(taskPath(projectId, task.taskNumber));
    },
    [tasks, router, projectId]
  );

  const sortContext = useMemo(
    () => ({
      statusOrder: new Map(effectiveColumns(project?.columns).map((c, i) => [c.id, i])),
      sprintById: new Map(sprints.map((sp) => [sp._id, sp])),
      fieldById: new Map((project?.customFields || []).map((f) => [f._id, f])),
    }),
    [project?.columns, project?.customFields, sprints]
  );

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (openLayerCount() > 0 && e.key !== "?") return;

      const noMod = !e.metaKey && !e.ctrlKey && !e.altKey;

      if (e.key === "n" && noMod && !readOnly) {
        e.preventDefault();
        setShowNewTask(true);
        return;
      }
      if (e.key === "Escape") {
        // BP-522: an open layer owns Escape — clearing the selection under the bulk-delete
        // confirm relabelled it "delete 0 tasks" and deleting nothing reported success
        if (openLayerCount() > 0) return;
        setSelectedTasks(new Set());
        setSelectionMode(false);
        setFocusedTaskIndex(-1);
        return;
      }
      if (e.key === "?" && noMod) {
        e.preventDefault();
        setShowShortcutHelp((v) => !v);
        return;
      }
      if (e.key === "v" && noMod && !pinViewMode) {
        e.preventDefault();
        setViewMode(viewMode === "board" ? "list" : "board");
        return;
      }
      if (e.key === "r" && noMod) {
        e.preventDefault();
        reload();
        return;
      }
      // J/K navigation in list view
      if (e.key === "j" && noMod) {
        e.preventDefault();
        setFocusedTaskIndex((prev) => {
          const max = filteredTasks.length - 1;
          return Math.min(prev + 1, max);
        });
        return;
      }
      if (e.key === "k" && noMod) {
        e.preventDefault();
        setFocusedTaskIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Enter" && noMod && focusedTaskIndex >= 0 && focusedTaskIndex < filteredTasks.length) {
        e.preventDefault();
        const task = filteredTasks[focusedTaskIndex];
        router.push(taskPath(projectId, task.taskNumber));
        return;
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    filteredTasks,
    focusedTaskIndex,
    projectId,
    router,
    reload,
    viewMode,
    setViewMode,
    setShowNewTask,
    setSelectedTasks,
    setSelectionMode,
    readOnly,
    pinViewMode,
  ]);

  function handleTaskSelect(taskId: string) {
    setSelectedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  }

  if (!project) return null;

  return (
    <>
      <BoardFilters
        tasks={tasks}
        customFields={project.customFields || []}
        projectKey={project.key}
        categories={(project.categories || []).map((c) => c.name)}
        projectCategories={project.categories || []}
        projectId={projectId}
        currentUsername={user?.username}
        sortField={sortField}
        sortDir={sortDir}
        onSortChange={(field, dir) => {
          setSortField(field);
          setSortDir(dir);
        }}
        sortFields={viewMode === "list" ? LIST_SORT_FIELDS : BOARD_SORT_FIELDS}
        sortContext={sortContext}
        hiddenColumns={hiddenColumns}
        onHiddenColumnsChange={setHiddenColumns}
        showColumnPicker={viewMode === "list"}
        extraControls={
          readOnly ? undefined : (
            <button
              onClick={() => {
                setSelectionMode((on) => !on);
                setSelectedTasks(new Set());
              }}
              className={`focus-ring flex h-11 items-center text-[13px] px-2.5 rounded-lg border transition-colors
                ${selectionMode
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-text-muted hover:text-text hover:border-border"
                }`}
              title="Select multiple tasks, then right-click one of them"
            >
              {selectedTasks.size > 0 ? `Select (${selectedTasks.size})` : "Select"}
            </button>
          )
        }
        onFilter={setFilteredTasks}
      />

      {/* board.tasks still holds the previous scope's list until its own request lands —
          swapping the task area in for a beat rather than showing those stale cards.
          The header and filter bar above stay put; only this region blanks. */}
      {loadedScope !== scope ? (
        <div className="flex justify-center py-12" role="status" aria-label="Loading tasks">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
        </div>
      ) : (
        <>
          {tasks.length === 0 &&
            (emptyState !== undefined ? (
              emptyState
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <svg className="w-16 h-16 text-text-muted/30 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                <h2 className="text-lg font-medium text-text-muted mb-2">No tasks yet</h2>
                <p className="text-sm text-text-muted mb-4">Create your first task to get started</p>
                {!readOnly && (
                  <Button size="sm" onClick={() => setShowNewTask(true)}>
                    Create Task
                  </Button>
                )}
              </div>
            ))}

          {/* Without this the empty state sits above a strip of zero-count columns.
              ListView already returns null when it has no tasks; Board did not. */}
          {tasks.length > 0 && (
          <div className={`lg:flex-1 lg:min-h-0 ${viewMode === "board" ? "lg:overflow-hidden" : "lg:overflow-y-auto"}`}>
          {viewMode === "board" ? (
            <Board
              tasks={filteredTasks}
              projectKey={project.key}
              customFields={project.customFields || []}
              projectCategories={project.categories || []}
              columns={project.columns || []}
              selectedTasks={readOnly ? undefined : selectedTasks}
              selectionMode={readOnly ? undefined : selectionMode}
              collapseEmptyColumns={user?.collapseEmptyColumns ?? true}
              onStatusChange={readOnly ? undefined : handleStatusChange}
              onTaskDrop={readOnly ? undefined : handleTaskDrop}
              onTaskClick={openTask}
              onTaskSelect={readOnly ? undefined : handleTaskSelect}
              onTaskContextMenu={readOnly ? undefined : (taskId, x, y) => setContextMenu({ taskId, x, y })}
              readOnly={readOnly}
            />
          ) : (
            <ListView
              tasks={filteredTasks}
              projectKey={project.key}
              projectId={projectId}
              customFields={project.customFields || []}
              sprints={sprints}
              categories={project.categories || []}
              columns={project.columns || []}
              focusedIndex={focusedTaskIndex}
              selectedTasks={readOnly ? undefined : selectedTasks}
              selectionMode={readOnly ? undefined : selectionMode}
              sortField={sortField}
              sortDir={sortDir}
              onSortChange={(field, dir) => {
                setSortField(field);
                setSortDir(dir);
              }}
              hiddenColumns={hiddenColumns}
              assignableUsers={assignableUsers}
              onTaskClick={openTask}
              onStatusChange={readOnly ? undefined : handleStatusChange}
              onAssigneeChange={readOnly ? undefined : handleAssigneeChange}
              onTaskSelect={readOnly ? undefined : handleTaskSelect}
              onTaskContextMenu={readOnly ? undefined : (taskId, x, y) => setContextMenu({ taskId, x, y })}
              onReorder={readOnly ? undefined : handleReorder}
              onPriorityChange={
                readOnly
                  ? undefined
                  : (taskId, priority) => patchTask(taskId, { priority }, "priority")
              }
              onCategoryChange={
                readOnly
                  ? undefined
                  : (taskId, category) => patchTask(taskId, { category }, "category")
              }
              onSprintChange={readOnly ? undefined : handleRowSprintChange}
              onFieldChange={readOnly ? undefined : handleFieldValueChange}
            />
          )}
          </div>
          )}
        </>
      )}

      {/* readOnly can flip true while this menu is already open; contextMenu state does
          not reset itself, so withholding the menu here — not just the handler that opens
          it — is what actually closes the window. The two dialogs below need it too. */}
      {!readOnly && contextMenu && (() => {
        const task = tasks.find((t) => t._id === contextMenu.taskId);
        if (!task) return null;
        // Right-clicking inside the selection acts on all of it; outside it acts on that task alone
        const bulk = selectedTasks.has(contextMenu.taskId) ? selectedTasks.size : 1;
        return (
          <TaskContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            currentStatus={task.status}
            sprints={sprints.filter((s) => s.status !== "completed")}
            columns={project.columns || []}
            currentSprint={task.sprint}
            selectedCount={bulk}
            onStatusChange={(status) =>
              bulk > 1 ? handleBulkMove(status) : handleStatusChange(contextMenu.taskId, status)
            }
            onSprintChange={async (sprintId) => {
              if (bulk > 1) {
                handleBulkSprint(sprintId);
                return;
              }
              const taskId = contextMenu.taskId;
              applySprintChange([taskId], sprintId);
              try {
                await api.put(`/api/projects/${projectId}/tasks/${taskId}`, { sprint: sprintId });
                const target = sprintId
                  ? sprints.find((s) => s._id === sprintId)?.name ?? "sprint"
                  : "backlog";
                toast(`Moved to ${target}`, "success");
              } catch {
                toast("Failed to move task to sprint", "error");
                reload();
              }
            }}
            onDuplicate={() => handleContextDuplicate(contextMenu.taskId)}
            onDelete={() => {
              if (bulk > 1) setConfirmBulkDelete(true);
              else setConfirmContextDelete(contextMenu.taskId);
              setContextMenu(null);
            }}
            onClose={() => setContextMenu(null)}
          />
        );
      })()}

      <ConfirmDialog
        open={!readOnly && !!confirmContextDelete}
        onClose={() => setConfirmContextDelete(null)}
        onConfirm={() => confirmContextDelete && handleContextDelete(confirmContextDelete)}
        title="Delete Task"
        message="Are you sure you want to delete this task? This action cannot be undone."
        confirmLabel="Delete"
        loading={deleting}
      />

      {/* The delete was refused for the same reason, and asks separately because the cost is not
          the same one: a forced move takes the task off the worker, a forced delete takes the
          task. */}
      <ConfirmDialog
        open={!!heldDelete}
        onClose={() => {
          setHeldDelete(null);
          reload();
        }}
        onConfirm={forceHeldDelete}
        title="This task is being executed"
        message={
          heldDelete
            ? `${heldDelete.taskKey} is being executed by ${heldDelete.conflict.workerName || heldDelete.conflict.workerId || "a worker"} (phase ${heldDelete.conflict.phase}). Deleting it takes the task off that worker, and the task and its comments are gone for good.`
            : ""
        }
        confirmLabel="Delete anyway"
      />

      {/* The move was refused because a worker is running the task. Taking it costs that run,
          so it needs a deliberate click rather than a link in a toast that disappears. */}
      <ConfirmDialog
        open={!!heldMove}
        onClose={() => {
          setHeldMove(null);
          reload();
        }}
        onConfirm={forceHeldMove}
        title="This task is being executed"
        message={
          heldMove
            ? `${heldMove.taskKey} is being executed by ${heldMove.conflict.workerName || heldMove.conflict.workerId || "a worker"} (phase ${heldMove.conflict.phase}). Moving it takes the task off that worker and its work is lost.`
            : ""
        }
        confirmLabel="Move anyway"
      />

      {!readOnly && (
        <NewTaskModal
          projectId={projectId}
          project={project}
          sprints={sprints}
          scope={scope}
          open={showNewTask}
          onClose={() => setShowNewTask(false)}
          onSaved={() => {
            setShowNewTask(false);
            reload();
          }}
        />
      )}


      <ShortcutHelp
        open={showShortcutHelp}
        onClose={() => setShowShortcutHelp(false)}
      />

      <ConfirmDialog
        open={!readOnly && confirmBulkDelete}
        onClose={() => setConfirmBulkDelete(false)}
        onConfirm={handleBulkDelete}
        title="Delete Selected Tasks"
        message={`Are you sure you want to delete ${selectedTasks.size} task${selectedTasks.size === 1 ? "" : "s"}? This action cannot be undone.`}
        confirmLabel={`Delete ${selectedTasks.size} task${selectedTasks.size === 1 ? "" : "s"}`}
        loading={bulkDeleting}
      />
    </>
  );
}
