"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { usePollWhileVisible } from "@/hooks/use-poll-while-visible";
import { ApiProject, ApiTask, ApiSprint , ApiUserSummary, BOARD_SORT_FIELDS, LIST_SORT_FIELDS, SortField, SortKey, SortDir } from "@/types";
import { effectiveColumns } from "@/lib/columns";
import { ListColumnId } from "@/lib/list-columns";
import { subscribeBoardRefresh } from "@/lib/board-refresh";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Board } from "@/components/kanban/Board";
import { BoardFilters } from "@/components/kanban/BoardFilters";
import { TaskForm } from "@/components/tasks/TaskForm";
import { TaskContextMenu } from "@/components/kanban/TaskContextMenu";
import { ListView } from "@/components/kanban/ListView";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { ShortcutHelp } from "@/components/ui/ShortcutHelp";
import { useCanonicalUrl } from "@/hooks/use-canonical-url";
import { projectPath, taskPath } from "@/lib/urls";
import { BoardHeader } from "@/components/kanban/BoardHeader";
import { sprintDefaultForNewTask, sprintScopeFromParam, sprintScopeToQuery } from "@/lib/sprint-scope";

// "relates" is symmetric and "duplicates" has a readable inverse, so a card should
// show a relation regardless of which side created it. Every task is already loaded,
// so the reverse side is derived here instead of costing another request.
function withIncomingRelations(tasks: ApiTask[]): ApiTask[] {
  const incoming = new Map<string, ApiTask["relatedFrom"]>();
  for (const task of tasks) {
    for (const relation of task.relations || []) {
      const targetId = relation.task?._id;
      if (!targetId) continue;
      const entry = {
        type: relation.type,
        task: {
          _id: task._id,
          taskNumber: task.taskNumber,
          title: task.title,
          status: task.status,
        },
      };
      incoming.set(targetId, [...(incoming.get(targetId) || []), entry]);
    }
  }
  return tasks.map((task) => ({ ...task, relatedFrom: incoming.get(task._id) || [] }));
}

export default function KanbanPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const api = useApi();
  const { user, isAdmin } = useAuth();
  const searchParams = useSearchParams();

  // Scope lives in the URL so it survives a reload and can be shared;
  // filters stay in localStorage
  const selectedSprint = sprintScopeFromParam(searchParams.get("sprint"));
  const setSelectedSprint = useCallback(
    (scope: string) => router.push(projectPath(projectId) + sprintScopeToQuery(scope)),
    [router, projectId]
  );
  const { toast } = useToast();

  const [project, setProject] = useState<ApiProject | null>(null);
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [filteredTasks, setFilteredTasks] = useState<ApiTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewTask, setShowNewTask] = useState(false);
  const loadSeq = useRef(0);
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ taskId: string; x: number; y: number } | null>(null);
  const [confirmContextDelete, setConfirmContextDelete] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // One owner for both views: the filter bar's dropdown and the list's column
  // headers set the same value, and it survives switching between them
  const [sortField, setSortField] = useState<SortKey>("manual");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [hiddenColumns, setHiddenColumns] = useState<ListColumnId[]>([]);

  const [viewMode, setViewMode] = useState<"board" | "list">(() => {
    if (typeof window === "undefined") return "board";
    return localStorage.getItem(`view-mode:${projectId}`) === "list" ? "list" : "board";
  });
  const [sprints, setSprints] = useState<ApiSprint[]>([]);
  const [assignableUsers, setAssignableUsers] = useState<ApiUserSummary[]>([]);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [focusedTaskIndex, setFocusedTaskIndex] = useState(-1);

  // Tick every 60s so the activity indicator transitions from Working → Idle
  const tick = useCallback(() => setNow(Date.now()), []);
  usePollWhileVisible(tick, 60_000);


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

  const loadData = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const sprintParam = selectedSprint !== "all" ? `?sprint=${selectedSprint}` : "";
      const [proj, taskList, sprintList] = await Promise.all([
        api.get(`/api/projects/${projectId}`),
        api.get(`/api/projects/${projectId}/tasks${sprintParam}`),
        api.get(`/api/projects/${projectId}/sprints`),
      ]);
      // A slower earlier request must not overwrite what a later one already applied
      if (seq !== loadSeq.current) return;
      setProject(proj);
      setTasks(withIncomingRelations(taskList));
      setSprints(sprintList);
      setNow(Date.now());
    } catch {
      toast("Failed to load board data", "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, selectedSprint]);

  // Once, not on the board poll: the roster does not change while you work
  useEffect(() => {
    api.get("/api/users/list").then(setAssignableUsers).catch(() => setAssignableUsers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useCanonicalUrl(project?.key);

  usePollWhileVisible(loadData, 10_000);

  // Instant refresh when the PM chat reports a write action (poll stays as fallback).
  // Bursts are coalesced inside subscribeBoardRefresh.
  useEffect(() => subscribeBoardRefresh(projectId, loadData), [projectId, loadData]);

  // Update browser tab title with task counts
  useEffect(() => {
    if (!project) return;
    const todoCount = tasks.filter((t) => t.status === "todo").length;
    const inProgressCount = tasks.filter((t) => t.status === "in_progress").length;
    const parts: string[] = [];
    if (inProgressCount > 0) parts.push(`${inProgressCount} in progress`);
    if (todoCount > 0) parts.push(`${todoCount} todo`);
    const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    document.title = `${project.name}${suffix} — ClaudePlanner`;
    return () => { document.title = "ClaudePlanner"; };
  }, [project, tasks]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const noMod = !e.metaKey && !e.ctrlKey && !e.altKey;

      if (e.key === "n" && noMod) {
        e.preventDefault();
        setShowNewTask(true);
        return;
      }
      if (e.key === "Escape") {
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
      if (e.key === "v" && noMod) {
        e.preventDefault();
        setViewMode((prev) => {
          const next = prev === "board" ? "list" : "board";
          localStorage.setItem(`view-mode:${projectId}`, next);
          return next;
        });
        return;
      }
      if (e.key === "r" && noMod) {
        e.preventDefault();
        loadData();
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
  }, [filteredTasks, focusedTaskIndex, projectId, router, loadData]);

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

  async function handleBulkMove(status: string) {
    try {
      await Promise.all(
        Array.from(selectedTasks).map((id) =>
          api.patch(`/api/projects/${projectId}/tasks/${id}/status`, { status })
        )
      );
      setTasks((prev) =>
        prev.map((t) =>
          selectedTasks.has(t._id)
            ? { ...t, status: status as ApiTask["status"] }
            : t
        )
      );
      setSelectedTasks(new Set());
      toast(`Moved ${selectedTasks.size} task${selectedTasks.size === 1 ? "" : "s"}`, "success");
    } catch {
      toast("Failed to move tasks", "error");
    }
  }

  async function handleBulkSprint(sprintId: string | null) {
    const ids = Array.from(selectedTasks);
    try {
      await Promise.all(
        ids.map((id) =>
          api.put(`/api/projects/${projectId}/tasks/${id}`, { sprint: sprintId })
        )
      );
      applySprintChange(ids, sprintId);
      setSelectedTasks(new Set());
      const target = sprintId
        ? sprints.find((s) => s._id === sprintId)?.name ?? "sprint"
        : "backlog";
      toast(`Moved ${ids.length} task${ids.length === 1 ? "" : "s"} to ${target}`, "success");
    } catch {
      toast("Failed to move tasks to sprint", "error");
    }
  }

  // Tasks leaving the sprint the board is filtered by must disappear from it
  function applySprintChange(taskIds: string[], sprintId: string | null) {
    const affected = new Set(taskIds);
    setTasks((prev) => {
      const updated = prev.map((t) =>
        affected.has(t._id) ? { ...t, sprint: sprintId } : t
      );
      if (selectedSprint === "all") return updated;
      const wanted = selectedSprint === "backlog" ? null : selectedSprint;
      return updated.filter((t) => !affected.has(t._id) || t.sprint === wanted);
    });
  }

  async function handleBulkDelete() {
    setBulkDeleting(true);
    try {
      await Promise.all(
        Array.from(selectedTasks).map((id) =>
          api.del(`/api/projects/${projectId}/tasks/${id}`)
        )
      );
      setTasks((prev) => prev.filter((t) => !selectedTasks.has(t._id)));
      const count = selectedTasks.size;
      setSelectedTasks(new Set());
      setConfirmBulkDelete(false);
      toast(`Deleted ${count} task${count === 1 ? "" : "s"}`, "success");
    } catch {
      toast("Failed to delete tasks", "error");
    } finally {
      setBulkDeleting(false);
    }
  }

  async function handleAssigneeChange(taskId: string, username: string) {
    try {
      // PUT, not PATCH: the task route exposes GET/PUT/DELETE, and updateTask
      // copies only the fields present in the body, so this stays a partial update.
      // null, not "": task-service only resolves a non-empty string, so "" would
      // reach Mongoose as a cast error instead of clearing the field
      const updated = await api.put(`/api/projects/${projectId}/tasks/${taskId}`, {
        assignee: username || null,
      });
      setTasks((prev) =>
        prev.map((t) => (t._id === taskId ? { ...t, assignee: updated.assignee } : t))
      );
    } catch {
      toast("Failed to update assignee", "error");
    }
  }

  async function handleStatusChange(taskId: string, status: string) {
    try {
      await api.patch(
        `/api/projects/${projectId}/tasks/${taskId}/status`,
        { status }
      );
      setTasks((prev) =>
        prev.map((t) =>
          t._id === taskId ? { ...t, status: status as ApiTask["status"] } : t
        )
      );
    } catch {
      toast("Failed to update status", "error");
    }
  }

  async function handleTaskDrop(taskId: string, status: string, dropIndex: number) {
    // Get tasks in the target column, excluding the dragged task
    const columnTasks = tasks
      .filter((t) => t.status === status && t._id !== taskId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    let newOrder: number;
    if (columnTasks.length === 0) {
      newOrder = 0;
    } else if (dropIndex <= 0) {
      newOrder = (columnTasks[0].order ?? 0) - 1;
    } else if (dropIndex >= columnTasks.length) {
      newOrder = (columnTasks[columnTasks.length - 1].order ?? 0) + 1;
    } else {
      const before = columnTasks[dropIndex - 1].order ?? 0;
      const after = columnTasks[dropIndex].order ?? 0;
      newOrder = (before + after) / 2;
    }

    // Optimistic update
    setTasks((prev) =>
      prev.map((t) =>
        t._id === taskId
          ? { ...t, status: status as ApiTask["status"], order: newOrder }
          : t
      )
    );

    try {
      await api.put(`/api/projects/${projectId}/tasks/${taskId}`, {
        status,
        order: newOrder,
      });
    } catch {
      toast("Failed to move task", "error");
      loadData();
    }
  }

  async function handleContextDuplicate(taskId: string) {
    const task = tasks.find((t) => t._id === taskId);
    if (!task) return;
    try {
      await api.post(`/api/projects/${projectId}/tasks`, {
        title: `Copy of ${task.title}`,
        description: task.description,
        difficulty: task.difficulty,
        priority: task.priority,
        category: task.category,
        component: task.component,
        checklist: task.checklist,
        dueDate: task.dueDate,
        status: "planned",
      });
      toast("Task duplicated", "success");
      loadData();
    } catch {
      toast("Failed to duplicate task", "error");
    }
  }

  async function handleContextDelete(taskId: string) {
    try {
      await api.del(`/api/projects/${projectId}/tasks/${taskId}`);
      setTasks((prev) => prev.filter((t) => t._id !== taskId));
      toast("Task deleted", "success");
    } catch {
      toast("Failed to delete task", "error");
    } finally {
      setConfirmContextDelete(null);
    }
  }

  if (loading || !project) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="lg:flex-1 lg:min-h-0 lg:flex lg:flex-col lg:overflow-hidden">
      <BoardHeader
        projectName={project.name}
        projectIcon={project.icon}
        projectDescription={project.description}
        sprints={sprints}
        scope={selectedSprint}
        onScopeChange={setSelectedSprint}
        viewMode={viewMode}
        onViewModeChange={(mode) => {
          setViewMode(mode);
          localStorage.setItem(`view-mode:${projectId}`, mode);
        }}
        onRefresh={loadData}
        onNewTask={() => setShowNewTask(true)}
      />

      <BoardFilters
        tasks={tasks}
        customFields={project.customFields || []}
        components={project.components}
        projectKey={project.key}
        labels={project.labels || []}
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
        {...(viewMode === "list" ? { onHiddenColumnsChange: setHiddenColumns } : {})}
        extraControls={
          <button
            onClick={() => {
              setSelectionMode((on) => !on);
              setSelectedTasks(new Set());
            }}
            className={`focus-ring text-xs px-3 py-1.5 rounded-lg border transition-colors
              ${selectionMode
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-text-muted hover:text-text hover:border-border"
              }`}
            title="Select multiple tasks, then right-click one of them"
          >
            {selectedTasks.size > 0 ? `Select (${selectedTasks.size})` : "Select"}
          </button>
        }
        onFilter={setFilteredTasks}
      />

      {tasks.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <svg className="w-16 h-16 text-text-muted/30 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <h2 className="text-lg font-medium text-text-muted mb-2">No tasks yet</h2>
          <p className="text-sm text-text-muted mb-4">Create your first task to get started</p>
          <Button size="sm" onClick={() => setShowNewTask(true)}>
            Create Task
          </Button>
        </div>
      )}

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
          selectedTasks={selectedTasks}
          selectionMode={selectionMode}
          collapseEmptyColumns={user?.collapseEmptyColumns ?? true}
          onStatusChange={handleStatusChange}
          onTaskDrop={handleTaskDrop}
          onTaskClick={openTask}
          onTaskSelect={handleTaskSelect}
          onTaskContextMenu={(taskId, x, y) => setContextMenu({ taskId, x, y })}
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
          selectedTasks={selectedTasks}
          selectionMode={selectionMode}
          sortField={sortField}
          sortDir={sortDir}
          onSortChange={(field, dir) => {
            setSortField(field);
            setSortDir(dir);
          }}
          hiddenColumns={hiddenColumns}
          assignableUsers={assignableUsers}
          onTaskClick={openTask}
          onStatusChange={handleStatusChange}
          onAssigneeChange={handleAssigneeChange}
          onTaskSelect={handleTaskSelect}
          onTaskContextMenu={(taskId, x, y) => setContextMenu({ taskId, x, y })}
        />
      )}
      </div>
      )}

      {contextMenu && (() => {
        const task = tasks.find((t) => t._id === contextMenu.taskId);
        if (!task) return null;
        // Right-clicking inside the selection acts on all of it; outside it acts on that task alone
        const bulk = selectedTasks.has(contextMenu.taskId) ? selectedTasks.size : 1;
        return (
          <TaskContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            currentStatus={task.status}
            isPinned={task.pinned}
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
                loadData();
              }
            }}
            onPin={async () => {
              const newPinned = !task.pinned;
              setTasks((prev) => prev.map((t) => t._id === contextMenu.taskId ? { ...t, pinned: newPinned } : t));
              try {
                await api.put(`/api/projects/${projectId}/tasks/${contextMenu.taskId}`, { pinned: newPinned });
              } catch {
                toast("Failed to toggle pin", "error");
                loadData();
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
        open={!!confirmContextDelete}
        onClose={() => setConfirmContextDelete(null)}
        onConfirm={() => confirmContextDelete && handleContextDelete(confirmContextDelete)}
        title="Delete Task"
        message="Are you sure you want to delete this task? This action cannot be undone."
        confirmLabel="Delete"
      />

      <Modal
        open={showNewTask}
        onClose={() => setShowNewTask(false)}
        title="New Task"
        size="lg"
      >
        <TaskForm
          projectId={projectId}
          projectKey={project.key}
          components={project.components}
          categories={(project.categories || []).map((c) => c.name)}
          columns={project.columns || []}
          projectLabels={project.labels || []}
          taskTemplates={project.taskTemplates || []}
          sprints={sprints}
          defaultSprint={sprintDefaultForNewTask(selectedSprint)}
          customFields={project.customFields || []}
          onSaved={() => {
            setShowNewTask(false);
            loadData();
          }}
          onCancel={() => setShowNewTask(false)}
        />
      </Modal>


      <ShortcutHelp
        open={showShortcutHelp}
        onClose={() => setShowShortcutHelp(false)}
      />

      <ConfirmDialog
        open={confirmBulkDelete}
        onClose={() => setConfirmBulkDelete(false)}
        onConfirm={handleBulkDelete}
        title="Delete Selected Tasks"
        message={`Are you sure you want to delete ${selectedTasks.size} task${selectedTasks.size === 1 ? "" : "s"}? This action cannot be undone.`}
        confirmLabel={`Delete ${selectedTasks.size} task${selectedTasks.size === 1 ? "" : "s"}`}
        loading={bulkDeleting}
      />
    </div>
  );
}
