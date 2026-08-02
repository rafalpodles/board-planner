"use client";

import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { Badge } from "@/components/ui/Badge";
import { STATUS_LABELS, PRIORITY_LABELS, DEFAULT_PROJECT_ICON, Priority, TaskStatus } from "@/types";
import { projectPath, taskPath } from "@/lib/urls";
import { PageHeader } from "@/components/shell/PageHeader";

interface MyTask {
  _id: string;
  taskNumber: number;
  title: string;
  status: TaskStatus;
  difficulty: string;
  priority: Priority;
  category: string;
  component: string;
  updatedAt: string;
  project: { _id: string; name: string; key: string; icon?: string };
}

const statusOrder: Record<string, number> = {
  in_progress: 0,
  needs_human_review: 1,
  in_review: 2,
  todo: 3,
  ready_to_test: 4,
  planned: 5,
  done: 6,
};

export default function MyTasksPage() {
  const [tasks, setTasks] = useState<MyTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [hideDone, setHideDone] = useState(true);
  const api = useApi();
  const { toast } = useToast();

  useEffect(() => {
    api
      .get("/api/tasks/mine")
      .then(setTasks)
      .catch(() => toast("Failed to load tasks", "error"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = hideDone ? tasks.filter((t) => t.status !== "done") : tasks;
  const sorted = [...filtered].sort(
    (a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9)
  );

  // Group by project
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

  return (
    <div>
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
                      style={{ "--chip": statusAccent(task.status) } as CSSProperties}
                    >
                      {STATUS_LABELS[task.status]}
                    </span>
                    <span className="text-sm flex-1 truncate">{task.title}</span>
                    <div className="flex gap-1 flex-shrink-0">
                      <Badge variant="priority" value={task.priority}>
                        {PRIORITY_LABELS[task.priority] ?? task.priority}
                      </Badge>
                      <Badge variant="difficulty" value={task.difficulty}>
                        {task.difficulty}
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

function statusAccent(status: string): string {
  switch (status) {
    case "in_progress":
      return "var(--color-status-in-progress)";
    case "in_review":
      return "var(--color-status-in-review)";
    case "needs_human_review":
      return "var(--color-status-needs-human-review)";
    case "todo":
      return "var(--color-status-todo)";
    case "ready_to_test":
      return "var(--color-status-ready-to-test)";
    case "done":
      return "var(--color-status-done)";
    default:
      return "var(--color-status-planned)";
  }
}
