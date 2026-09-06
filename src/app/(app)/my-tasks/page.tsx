"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PRIORITY_LABELS, DEFAULT_PROJECT_ICON, ColumnRole, Priority, TaskStatus } from "@/types";
import { ROLE_ORDER } from "@/lib/columns";
import { projectPath, taskPath } from "@/lib/urls";
import { PageHeader } from "@/components/shell/PageHeader";

interface MyTask {
  _id: string;
  taskNumber: number;
  title: string;
  status: TaskStatus;
  priority: Priority;
  category: string;
  updatedAt: string;
  project: { _id: string; name: string; key: string; icon?: string };
  statusRole: ColumnRole | null;
  statusLabel: string;
  statusColor: string | null;
}

type IncomingTask = Omit<MyTask, "project"> & { project: MyTask["project"] | null };

const orderOf = (task: MyTask) =>
  task.statusRole ? ROLE_ORDER[task.statusRole] : Object.keys(ROLE_ORDER).length;

export default function MyTasksPage() {
  const [tasks, setTasks] = useState<MyTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [hideDone, setHideDone] = useState(true);
  const api = useApi();
  const { toast } = useToast();
  const loadSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    setLoading(true);
    api
      .get("/api/tasks/mine")
      .then((mine: IncomingTask[]) => {
        if (seq !== loadSeq.current) return;
        setTasks(mine.filter((task): task is MyTask => !!task.project));
        setFailed(false);
      })
      .catch(() => {
        if (seq !== loadSeq.current) return;
        setFailed(true);
        toast("Failed to load tasks", "error");
      })
      .finally(() => {
        if (seq === loadSeq.current) setLoading(false);
      });
  }, [api, toast]);

  useEffect(load, [load]);

  const filtered = hideDone ? tasks.filter((t) => t.statusRole !== "done") : tasks;
  const sorted = [...filtered].sort((a, b) => orderOf(a) - orderOf(b));

  const grouped: Record<string, { project: MyTask["project"]; tasks: MyTask[] }> = {};
  for (const task of sorted) {
    const pid = task.project._id;
    if (!grouped[pid]) {
      grouped[pid] = { project: task.project, tasks: [] };
    }
    grouped[pid].tasks.push(task);
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (failed) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <p role="alert" className="text-sm text-text-muted">
          Failed to load your tasks.
        </p>
        <Button size="sm" onClick={load}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto w-full">
      <PageHeader
        title="My Tasks"
        subtitle={sorted.length === 1 ? "1 task" : `${sorted.length} tasks`}
        actions={
          <label className="flex cursor-pointer items-center gap-2 text-sm text-text-muted">
            <input
              type="checkbox"
              checked={hideDone}
              onChange={(e) => setHideDone(e.target.checked)}
              className="focus-ring rounded border-border"
            />
            Hide done
          </label>
        }
      />

      {sorted.length === 0 ? (
        <div className="text-center py-12 text-text-muted">
          <p>{tasks.length === 0 ? "No tasks assigned to you" : "All tasks are done!"}</p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.values(grouped).map(({ project, tasks: projectTasks }) => (
            <div key={project._id}>
              <Link
                href={projectPath(project.key)}
                className="text-sm font-medium text-text-muted hover:text-text mb-2 flex items-center gap-2"
              >
                <span aria-hidden="true">{project.icon || DEFAULT_PROJECT_ICON}</span>
                <span className="font-mono text-xs bg-bg-input px-2 py-0.5 rounded">
                  {project.key}
                </span>
                {project.name}
              </Link>

              <div className="space-y-1">
                {projectTasks.map((task) => (
                  <Link
                    key={task._id}
                    href={taskPath(project.key, task.taskNumber)}
                    className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-bg-card hover:border-primary/50 transition-colors block"
                  >
                    <span className="text-xs font-mono text-text-muted w-16 flex-shrink-0">
                      {project.key}-{task.taskNumber}
                    </span>
                    <span
                      className="chip text-xs px-2 py-0.5 rounded-full flex-shrink-0"
                      style={{ "--chip": statusAccent(task) } as CSSProperties}
                    >
                      {task.statusLabel}
                    </span>
                    <span className="text-sm flex-1 truncate">{task.title}</span>
                    <div className="flex gap-1 flex-shrink-0">
                      <Badge variant="priority" value={task.priority}>
                        {PRIORITY_LABELS[task.priority] ?? task.priority}
                      </Badge>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function statusAccent(task: MyTask): string {
  return task.statusColor || "var(--color-status-planned)";
}
