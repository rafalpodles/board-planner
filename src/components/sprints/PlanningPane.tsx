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
  onDropTask?: (taskId: string) => void;
}

export function PlanningPane({ title, tasks, projectKey, emptyMessage }: PlanningPaneProps) {
  const router = useRouter();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h3 className="mb-2 shrink-0 text-sm font-medium text-text-muted">
        {title} ({tasks.length})
      </h3>
      {tasks.length === 0 ? (
        <p className="py-8 text-center text-sm text-text-muted">{emptyMessage}</p>
      ) : (
        <div className="flex-1 space-y-2 overflow-y-auto">
          {tasks.map((task) => (
            <TaskCard
              key={task._id}
              task={task}
              projectKey={projectKey}
              onClick={() => router.push(taskPath(projectKey, task.taskNumber))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
