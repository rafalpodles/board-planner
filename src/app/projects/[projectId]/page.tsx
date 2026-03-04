"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { ApiProject, ApiTask, TASK_STATUSES, STATUS_LABELS } from "@/types";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Board } from "@/components/kanban/Board";
import { BoardFilters } from "@/components/kanban/BoardFilters";
import { TaskForm } from "@/components/tasks/TaskForm";
import { ImportDialog } from "@/components/import-export/ImportDialog";
import { ExportDialog } from "@/components/import-export/ExportDialog";
import { TaskContextMenu } from "@/components/kanban/TaskContextMenu";
import { ListView } from "@/components/kanban/ListView";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";

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
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ taskId: string; x: number; y: number } | null>(null);
  const [confirmContextDelete, setConfirmContextDelete] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [viewMode, setViewMode] = useState<"board" | "list">(() => {
    if (typeof window === "undefined") return "board";
    return (localStorage.getItem(`view-mode:${projectId}`) as "board" | "list") || "board";
  });

  // Tick every 60s so the activity indicator transitions from Working → Idle
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const activityStatus = useMemo(() => {
    if (tasks.length === 0) return null;
    const latest = Math.max(...tasks.map((t) => new Date(t.updatedAt).getTime()));
    const minutesAgo = (now - latest) / 60_000;
    return minutesAgo < 15 ? "working" : "idle";
  }, [tasks, now]);

  const loadData = useCallback(async () => {
    try {
      const [proj, taskList] = await Promise.all([
        api.get(`/api/projects/${projectId}`),
        api.get(`/api/projects/${projectId}/tasks`),
      ]);
      setProject(proj);
      setTasks(taskList);
      setNow(Date.now());
    } catch {
      toast("Failed to load board data", "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 10_000);
    return () => clearInterval(interval);
  }, [loadData]);

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

      if (e.key === "n" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setShowNewTask(true);
      }
      if (e.key === "Escape") {
        setSelectedTasks(new Set());
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

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
        category: task.category,
        component: task.component,
        acceptanceCriteria: task.acceptanceCriteria,
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
    <div>
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-6">
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
            <h1 className="text-2xl font-bold">{project.name}</h1>
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
        <div className="flex flex-wrap gap-2">
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
              const next = viewMode === "board" ? "list" : "board";
              setViewMode(next);
              localStorage.setItem(`view-mode:${projectId}`, next);
            }}
            title={viewMode === "board" ? "Switch to list view" : "Switch to board view"}
          >
            {viewMode === "board" ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
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
          <Button
            size="sm"
            variant="ghost"
            onClick={() => router.push(`/projects/${projectId}/dashboard`)}
            title="Dashboard"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </Button>
          {isAdmin && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => router.push(`/projects/${projectId}/settings`)}
            >
              Settings
            </Button>
          )}
        </div>
      </div>

      <BoardFilters
        tasks={tasks}
        components={project.components}
        labels={project.labels || []}
        projectId={projectId}
        currentUsername={user?.username}
        onFilter={setFilteredTasks}
      />

      {tasks.length > 0 && (
        <div className="mb-4">
          <div className="flex items-center justify-between text-xs text-text-muted mb-1">
            <span>
              {tasks.filter((t) => t.status === "done").length}/{tasks.length} done
            </span>
            <span>
              {Math.round((tasks.filter((t) => t.status === "done").length / tasks.length) * 100)}%
            </span>
          </div>
          <div className="h-1.5 bg-bg-input rounded-full overflow-hidden">
            <div
              className="h-full bg-status-done rounded-full transition-all duration-300"
              style={{
                width: `${(tasks.filter((t) => t.status === "done").length / tasks.length) * 100}%`,
              }}
            />
          </div>
        </div>
      )}

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

      {selectedTasks.size > 0 && (
        <div className="mb-4 flex items-center gap-3 bg-bg-card border border-primary/30 rounded-lg px-4 py-2.5">
          <span className="text-sm font-medium">
            {selectedTasks.size} selected
          </span>
          <select
            onChange={(e) => {
              if (e.target.value) handleBulkMove(e.target.value);
              e.target.value = "";
            }}
            className="text-xs bg-bg-input border border-border rounded px-2 py-1.5 text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
            defaultValue=""
          >
            <option value="" disabled>Move to...</option>
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>
          <Button
            size="sm"
            variant="danger"
            onClick={() => setConfirmBulkDelete(true)}
          >
            Delete
          </Button>
          <button
            onClick={() => setSelectedTasks(new Set())}
            className="text-xs text-text-muted hover:text-text ml-auto"
          >
            Clear selection
          </button>
        </div>
      )}

      {viewMode === "board" ? (
        <Board
          tasks={filteredTasks}
          projectKey={project.key}
          projectLabels={project.labels || []}
          selectedTasks={selectedTasks}
          onStatusChange={handleStatusChange}
          onTaskDrop={handleTaskDrop}
          onTaskClick={(taskId) =>
            router.push(`/projects/${projectId}/tasks/${taskId}`)
          }
          onTaskSelect={handleTaskSelect}
          onTaskContextMenu={(taskId, x, y) => setContextMenu({ taskId, x, y })}
        />
      ) : (
        <ListView
          tasks={filteredTasks}
          projectKey={project.key}
          onTaskClick={(taskId) =>
            router.push(`/projects/${projectId}/tasks/${taskId}`)
          }
        />
      )}

      {contextMenu && (() => {
        const task = tasks.find((t) => t._id === contextMenu.taskId);
        if (!task) return null;
        return (
          <TaskContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            currentStatus={task.status}
            onStatusChange={(status) => handleStatusChange(contextMenu.taskId, status)}
            onDuplicate={() => handleContextDuplicate(contextMenu.taskId)}
            onDelete={() => {
              setConfirmContextDelete(contextMenu.taskId);
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
      >
        <TaskForm
          projectId={projectId}
          projectKey={project.key}
          components={project.components}
          projectLabels={project.labels || []}
          onSaved={() => {
            setShowNewTask(false);
            loadData();
          }}
          onCancel={() => setShowNewTask(false)}
        />
      </Modal>

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
