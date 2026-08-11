"use client";

import { useRouter } from "next/navigation";
import { ApiTask } from "@/types";
import { TaskCard } from "@/components/kanban/TaskCard";
import { taskPath } from "@/lib/urls";

interface PlanningPaneProps {
  title: string;
  tasks: ApiTask[];
  projectKey: string;
  emptyMessage: string;
  action: { label: (task: ApiTask) => string; onClick: (task: ApiTask) => void };
  actionIcon: "add" | "remove";
  onDropTask?: (taskId: string) => void;
  loading?: boolean;
  testId?: string;
}

function ActionIcon({ kind }: { kind: "add" | "remove" }) {
  const d = kind === "add" ? "M12 5v14M5 12h14" : "M5 12h14";
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-4 w-4">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
    </svg>
  );
}

export function PlanningPane({
  title,
  tasks,
  projectKey,
  emptyMessage,
  action,
  actionIcon,
  onDropTask,
  loading = false,
  testId,
}: PlanningPaneProps) {
  const router = useRouter();

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid={testId}
      onDragOver={onDropTask ? (e) => e.preventDefault() : undefined}
      onDrop={
        onDropTask
          ? (e) => {
              e.preventDefault();
              const taskId = e.dataTransfer.getData("text/plain");
              if (taskId) onDropTask(taskId);
            }
          : undefined
      }
    >
      <h3 className="mb-2 shrink-0 text-sm font-medium text-text-muted">
        {loading ? title : `${title} (${tasks.length})`}
      </h3>
      {loading ? (
        <p className="py-8 text-center text-sm text-text-muted">Loading…</p>
      ) : tasks.length === 0 ? (
        <p className="py-8 text-center text-sm text-text-muted">{emptyMessage}</p>
      ) : (
        <div className="flex-1 space-y-2 overflow-y-auto">
          {tasks.map((task) => (
            <div key={task._id} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <TaskCard
                  task={task}
                  projectKey={projectKey}
                  onClick={() => router.push(taskPath(projectKey, task.taskNumber))}
                />
              </div>
              <button
                type="button"
                aria-label={action.label(task)}
                onClick={() => action.onClick(task)}
                className="focus-ring shrink-0 rounded-md border border-border p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text lg:hidden"
              >
                <ActionIcon kind={actionIcon} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
