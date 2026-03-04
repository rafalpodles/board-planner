"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { Badge } from "@/components/ui/Badge";
import { STATUS_LABELS, TaskStatus } from "@/types";

interface MyTask {
  _id: string;
  taskNumber: number;
  title: string;
  status: TaskStatus;
  difficulty: string;
  category: string;
  component: string;
  updatedAt: string;
  project: { _id: string; name: string; key: string };
}

const statusOrder: Record<string, number> = {
  in_progress: 0,
  in_review: 1,
  todo: 2,
  ready_to_test: 3,
  planned: 4,
  done: 5,
};

export default function MyTasksPage() {
  const [tasks, setTasks] = useState<MyTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [hideDone, setHideDone] = useState(true);
  const api = useApi();
  const router = useRouter();
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
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">My Tasks</h1>
        <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={hideDone}
            onChange={(e) => setHideDone(e.target.checked)}
            className="rounded border-border"
          />
          Hide done
        </label>
      </div>

      {sorted.length === 0 ? (
        <div className="text-center py-12 text-text-muted">
          <p>{tasks.length === 0 ? "No tasks assigned to you" : "All tasks are done!"}</p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.values(grouped).map(({ project, tasks: projectTasks }) => (
            <div key={project._id}>
              <button
                onClick={() => router.push(`/projects/${project._id}`)}
                className="text-sm font-medium text-text-muted hover:text-text mb-2 flex items-center gap-2 cursor-pointer"
              >
                <span className="font-mono text-xs bg-bg-input px-2 py-0.5 rounded">
                  {project.key}
                </span>
                {project.name}
              </button>

              <div className="space-y-1">
                {projectTasks.map((task) => (
                  <button
                    key={task._id}
                    onClick={() =>
                      router.push(`/projects/${project._id}/tasks/${task._id}`)
                    }
                    className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-bg-card hover:border-primary/50 transition-colors cursor-pointer"
                  >
                    <span className="text-xs font-mono text-text-muted w-16 flex-shrink-0">
                      {project.key}-{task.taskNumber}
                    </span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full flex-shrink-0 ${
                        statusColor(task.status)
                      }`}
                    >
                      {STATUS_LABELS[task.status]}
                    </span>
                    <span className="text-sm flex-1 truncate">{task.title}</span>
                    <div className="flex gap-1 flex-shrink-0">
                      <Badge variant="difficulty" value={task.difficulty}>
                        {task.difficulty}
                      </Badge>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case "in_progress":
      return "bg-status-in-progress/20 text-status-in-progress";
    case "in_review":
      return "bg-status-in-review/20 text-status-in-review";
    case "todo":
      return "bg-status-todo/20 text-status-todo";
    case "ready_to_test":
      return "bg-status-ready-to-test/20 text-status-ready-to-test";
    case "done":
      return "bg-status-done/20 text-status-done";
    default:
      return "bg-status-planned/20 text-status-planned";
  }
}
