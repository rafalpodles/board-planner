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
    <div className="flex gap-4 overflow-x-auto pb-4 snap-x snap-mandatory sm:snap-none
      -mx-4 px-4 sm:mx-0 sm:px-0">
      {TASK_STATUSES.map((status) => (
        <div key={status} className="snap-center">
          <Column
            status={status}
            tasks={grouped[status]}
            projectKey={projectKey}
            onStatusChange={onStatusChange}
            onTaskClick={onTaskClick}
          />
        </div>
      ))}
    </div>
  );
}
