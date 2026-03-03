"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { ApiProject, ApiTask, TASK_STATUSES, STATUS_LABELS } from "@/types";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Board } from "@/components/kanban/Board";
import { BoardFilters } from "@/components/kanban/BoardFilters";
import { TaskForm } from "@/components/tasks/TaskForm";
import { ImportDialog } from "@/components/import-export/ImportDialog";
import { ExportDialog } from "@/components/import-export/ExportDialog";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";

export default function KanbanPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const api = useApi();
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
  const [now, setNow] = useState(() => Date.now());

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
    } catch (err) {
      console.error(err);
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
    } catch (err) {
      console.error(err);
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
    } catch (err) {
      console.error(err);
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
    } catch (err) {
      console.error(err);
      toast("Failed to update status", "error");
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
          <h1 className="text-2xl font-bold">{project.name}</h1>
          <div className="flex items-center gap-2">
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
            onClick={() => router.push(`/projects/${projectId}/settings`)}
          >
            Settings
          </Button>
        </div>
      </div>

      <BoardFilters
        tasks={tasks}
        components={project.components}
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

      <Board
        tasks={filteredTasks}
        projectKey={project.key}
        selectedTasks={selectedTasks}
        onStatusChange={handleStatusChange}
        onTaskClick={(taskId) =>
          router.push(`/projects/${projectId}/tasks/${taskId}`)
        }
        onTaskSelect={handleTaskSelect}
      />

      <Modal
        open={showNewTask}
        onClose={() => setShowNewTask(false)}
        title="New Task"
      >
        <TaskForm
          projectId={projectId}
          components={project.components}
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
