"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { ApiProject, ApiTask } from "@/types";
import { Board } from "@/components/kanban/Board";
import { TaskForm } from "@/components/tasks/TaskForm";
import { ImportDialog } from "@/components/import-export/ImportDialog";
import { ExportDialog } from "@/components/import-export/ExportDialog";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

export default function KanbanPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const api = useApi();

  const [project, setProject] = useState<ApiProject | null>(null);
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewTask, setShowNewTask] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [proj, taskList] = await Promise.all([
        api.get(`/api/projects/${projectId}`),
        api.get(`/api/projects/${projectId}/tasks`),
      ]);
      setProject(proj);
      setTasks(taskList);
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
      if (e.key === "n" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        setShowNewTask(true);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

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
          <p className="text-sm text-text-muted">{project.key}</p>
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

      <Board
        tasks={tasks}
        projectKey={project.key}
        onStatusChange={handleStatusChange}
        onTaskClick={(taskId) =>
          router.push(`/projects/${projectId}/tasks/${taskId}`)
        }
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
    </div>
  );
}
