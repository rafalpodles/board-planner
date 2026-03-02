"use client";

import { ApiTask, TASK_STATUSES, TaskStatus } from "@/types";
import { Column } from "./Column";

interface BoardProps {
  tasks: ApiTask[];
  projectKey: string;
  onStatusChange: (taskId: string, status: string) => void;
  onTaskClick: (taskId: string) => void;
}

export function Board({
  tasks,
  projectKey,
  onStatusChange,
  onTaskClick,
}: BoardProps) {
  const grouped = TASK_STATUSES.reduce(
    (acc, status) => {
      acc[status] = tasks.filter((t) => t.status === status);
      return acc;
    },
    {} as Record<TaskStatus, ApiTask[]>
  );

  return (
    <div className="overflow-x-auto pb-4">
      <div className="grid grid-cols-6 gap-4 min-w-[960px]">
        {TASK_STATUSES.map((status) => (
          <Column
            key={status}
            status={status}
            tasks={grouped[status]}
            projectKey={projectKey}
            onStatusChange={onStatusChange}
            onTaskClick={onTaskClick}
          />
        ))}
      </div>
    </div>
  );
}
