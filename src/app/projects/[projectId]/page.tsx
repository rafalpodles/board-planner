"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { usePollWhileVisible } from "@/hooks/use-poll-while-visible";
import { ApiProject, ApiTask, ApiSprint, DEFAULT_PROJECT_ICON } from "@/types";
import { effectiveColumns } from "@/lib/columns";
import { subscribeBoardRefresh } from "@/lib/board-refresh";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Board } from "@/components/kanban/Board";
import { BoardFilters } from "@/components/kanban/BoardFilters";
import { TaskForm } from "@/components/tasks/TaskForm";
import { ImportDialog } from "@/components/import-export/ImportDialog";
import { ExportDialog } from "@/components/import-export/ExportDialog";
import { TaskContextMenu } from "@/components/kanban/TaskContextMenu";
import { ListView } from "@/components/kanban/ListView";
import { TimelineView } from "@/components/kanban/TimelineView";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { ShortcutHelp } from "@/components/ui/ShortcutHelp";
import { SprintSelector } from "@/components/kanban/SprintSelector";

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
  const { toast } = useToast();

  const [project, setProject] = useState<ApiProject | null>(null);
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [filteredTasks, setFilteredTasks] = useState<ApiTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewTask, setShowNewTask] = useState(false);
  const [editTaskId, setEditTaskId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ taskId: string; x: number; y: number } | null>(null);
  const [confirmContextDelete, setConfirmContextDelete] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [viewMode, setViewMode] = useState<"board" | "list" | "timeline">(() => {
    if (typeof window === "undefined") return "board";
    return (localStorage.getItem(`view-mode:${projectId}`) as "board" | "list" | "timeline") || "board";
  });
  const [sprints, setSprints] = useState<ApiSprint[]>([]);
  const [selectedSprint, setSelectedSprint] = useState("all");
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [focusedTaskIndex, setFocusedTaskIndex] = useState(-1);

  // Tick every 60s so the activity indicator transitions from Working → Idle
  const tick = useCallback(() => setNow(Date.now()), []);
  usePollWhileVisible(tick, 60_000);

  const activityStatus = useMemo(() => {
    if (tasks.length === 0) return null;
    const latest = Math.max(...tasks.map((t) => new Date(t.updatedAt).getTime()));
    const minutesAgo = (now - latest) / 60_000;
    return minutesAgo < 15 ? "working" : "idle";
  }, [tasks, now]);

  const loadData = useCallback(async () => {
    try {
      const sprintParam = selectedSprint !== "all" ? `?sprint=${selectedSprint}` : "";
      const [proj, taskList, sprintList] = await Promise.all([
        api.get(`/api/projects/${projectId}`),
        api.get(`/api/projects/${projectId}/tasks${sprintParam}`),
        api.get(`/api/projects/${projectId}/sprints`),
      ]);
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

  usePollWhileVisible(loadData, 10_000);

  // Instant refresh when the PM chat reports a write action (poll stays as fallback)
  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeBoardRefresh(projectId, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(loadData, 300);
    });
    return () => {
      if (debounce) clearTimeout(debounce);
      unsubscribe();
    };
  }, [projectId, loadData]);

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
      if (e.key === "/" && noMod) {
        e.preventDefault();
        const searchInput = document.querySelector<HTMLInputElement>('input[placeholder*="Search"]');
        searchInput?.focus();
        return;
      }
      if (e.key === "v" && noMod) {
        e.preventDefault();
        setViewMode((prev) => {
          const next = prev === "board" ? "list" : prev === "list" ? "timeline" : "board";
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
        router.push(`/projects/${projectId}/tasks/${task._id}`);
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

  async function handleInterrupt(taskId: string) {
    try {
      const { task } = await api.post(
        `/api/projects/${projectId}/tasks/${taskId}/interrupt`,
        {}
      );
      setTasks((prev) => prev.map((t) => (t._id === taskId ? { ...t, status: task.status } : t)));
      toast("Interrupted — task returned to the queue with a note", "success");
    } catch {
      toast("Failed to interrupt work on the task", "error");
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
    <div className="lg:h-[calc(100vh-6.5rem)] lg:flex lg:flex-col lg:overflow-hidden">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-6 lg:shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <Link
              href="/projects"
              className="text-text-muted hover:text-text transition-colors"
              title="All projects"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </Link>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <span aria-hidden="true">{project.icon || DEFAULT_PROJECT_ICON}</span>
              {project.name}
            </h1>
          </div>
          <div className="flex items-center gap-2 ml-7">
            <p className="text-sm text-text-muted">{project.key}</p>
            {activityStatus && (
              <span className="flex items-center gap-1 text-xs text-text-muted">
                <span
                  className={`w-2 h-2 rounded-full ${
                    activityStatus === "working"
                      ? "bg-green-500 animate-pulse"
                      : "bg-gray-500"
                  }`}
                />
                {activityStatus === "working" ? "Working" : "Idle"}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <SprintSelector
            sprints={sprints}
            selected={selectedSprint}
            onChange={setSelectedSprint}
          />
          <Button size="sm" onClick={() => setShowNewTask(true)} title="New Task (N)">
            New Task <kbd className="ml-1 text-[10px] opacity-50 bg-bg-input px-1 rounded">N</kbd>
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setShowImport(true)}
          >
            Import
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setShowExport(true)}
          >
            Export
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const next = viewMode === "board" ? "list" : viewMode === "list" ? "timeline" : "board";
              setViewMode(next);
              localStorage.setItem(`view-mode:${projectId}`, next);
            }}
            title={viewMode === "board" ? "Switch to list view (V)" : viewMode === "list" ? "Switch to timeline view (V)" : "Switch to board view (V)"}
          >
            {viewMode === "board" ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
              </svg>
            ) : viewMode === "list" ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
              </svg>
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={loadData}
            title="Refresh board"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </Button>
          <Link href={`/projects/${projectId}/sprints`} title="Sprints">
            <Button size="sm" variant="ghost">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </Button>
          </Link>
          <Link href={`/projects/${projectId}/dashboard`} title="Dashboard">
            <Button size="sm" variant="ghost">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </Button>
          </Link>
          {project.pm?.enabled && (
            <Link href={`/projects/${projectId}/pm`} title="PM Agent">
              <Button size="sm" variant="ghost">PM</Button>
            </Link>
          )}
          {isAdmin && (
            <Link href={`/projects/${projectId}/settings`}>
              <Button size="sm" variant="ghost">Settings</Button>
            </Link>
          )}
        </div>
      </div>

      <BoardFilters
        tasks={tasks}
        components={project.components}
        projectKey={project.key}
        labels={project.labels || []}
        categories={(project.categories || []).map((c) => c.name)}
        projectId={projectId}
        currentUsername={user?.username}
        extraControls={
          <button
            onClick={() => {
              setSelectionMode((on) => !on);
              setSelectedTasks(new Set());
            }}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors
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

      {tasks.length > 0 && (() => {
        const doneIds = new Set(
          effectiveColumns(project.columns).filter((c) => c.role === "done").map((c) => c.id)
        );
        const doneCount = tasks.filter((t) => doneIds.has(t.status)).length;
        return (
        <div className="mb-4">
          <div className="flex items-center justify-between text-xs text-text-muted mb-1">
            <span>
              {doneCount}/{tasks.length} done
            </span>
            <span>
              {Math.round((doneCount / tasks.length) * 100)}%
            </span>
          </div>
          <div className="h-1.5 bg-bg-input rounded-full overflow-hidden">
            <div
              className="h-full bg-status-done rounded-full transition-all duration-300"
              style={{
                width: `${(doneCount / tasks.length) * 100}%`,
              }}
            />
          </div>
        </div>
        );
      })()}

      {tasks.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <svg className="w-16 h-16 text-text-muted/30 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <h2 className="text-lg font-medium text-text-muted mb-2">No tasks yet</h2>
          <p className="text-sm text-text-muted/70 mb-4">Create your first task to get started</p>
          <Button size="sm" onClick={() => setShowNewTask(true)}>
            Create Task
          </Button>
        </div>
      )}

      <div className={`lg:flex-1 lg:min-h-0 ${viewMode === "board" ? "lg:overflow-hidden" : "lg:overflow-y-auto"}`}>
      {viewMode === "board" ? (
        <Board
          tasks={filteredTasks}
          projectKey={project.key}
          projectLabels={project.labels || []}
          projectCategories={project.categories || []}
          columns={project.columns || []}
          selectedTasks={selectedTasks}
          selectionMode={selectionMode}
          onStatusChange={handleStatusChange}
          onTaskDrop={handleTaskDrop}
          onTaskClick={(taskId) => setEditTaskId(taskId)}
          onTaskSelect={handleTaskSelect}
          onTaskContextMenu={(taskId, x, y) => setContextMenu({ taskId, x, y })}
          onTaskInterrupt={handleInterrupt}
        />
      ) : viewMode === "list" ? (
        <ListView
          tasks={filteredTasks}
          projectKey={project.key}
          projectId={projectId}
          sprints={sprints}
          categories={project.categories || []}
          columns={project.columns || []}
          focusedIndex={focusedTaskIndex}
          selectedTasks={selectedTasks}
          selectionMode={selectionMode}
          onTaskClick={(taskId) => setEditTaskId(taskId)}
          onStatusChange={handleStatusChange}
          onTaskSelect={handleTaskSelect}
          onTaskContextMenu={(taskId, x, y) => setContextMenu({ taskId, x, y })}
        />
      ) : (
        <TimelineView
          tasks={filteredTasks}
          projectKey={project.key}
          columns={project.columns || []}
          selectedTasks={selectedTasks}
          selectionMode={selectionMode}
          onTaskClick={(taskId) => setEditTaskId(taskId)}
          onTaskSelect={handleTaskSelect}
          onTaskContextMenu={(taskId, x, y) => setContextMenu({ taskId, x, y })}
        />
      )}
      </div>

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
            onInterrupt={() => handleInterrupt(contextMenu.taskId)}
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
          customFields={project.customFields || []}
          onSaved={() => {
            setShowNewTask(false);
            loadData();
          }}
          onCancel={() => setShowNewTask(false)}
        />
      </Modal>

      {(() => {
        const editTask = tasks.find((t) => t._id === editTaskId);
        return (
          <Modal
            open={!!editTask}
            onClose={() => setEditTaskId(null)}
            title={editTask ? `${project.key}-${editTask.taskNumber}` : ""}
            size="lg"
          >
            {editTask && (
              <>
                <Link
                  href={`/projects/${projectId}/tasks/${editTask._id}`}
                  className="text-xs text-primary hover:underline inline-block mb-3"
                >
                  Open full task page (comments, dependencies, activity) &rarr;
                </Link>
                <TaskForm
                  projectId={projectId}
                  projectKey={project.key}
                  task={editTask}
                  components={project.components}
                  categories={(project.categories || []).map((c) => c.name)}
                  columns={project.columns || []}
                  projectLabels={project.labels || []}
                  sprints={sprints}
                  customFields={project.customFields || []}
                  onSaved={() => {
                    setEditTaskId(null);
                    loadData();
                  }}
                  onCancel={() => setEditTaskId(null)}
                />
              </>
            )}
          </Modal>
        );
      })()}

      <ImportDialog
        open={showImport}
        onClose={() => setShowImport(false)}
        projectId={projectId}
        onImported={loadData}
      />

      <ExportDialog
        open={showExport}
        onClose={() => setShowExport(false)}
        projectId={projectId}
      />

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
