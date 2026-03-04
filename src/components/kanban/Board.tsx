"use client";

import { ApiTask, TASK_STATUSES, TaskStatus } from "@/types";
import { Column } from "./Column";

interface BoardProps {
  tasks: ApiTask[];
  projectKey: string;
  selectedTasks?: Set<string>;
  onStatusChange: (taskId: string, status: string) => void;
  onTaskDrop?: (taskId: string, status: string, dropIndex: number) => void;
  onTaskClick: (taskId: string) => void;
  onTaskSelect?: (taskId: string) => void;
  onTaskContextMenu?: (taskId: string, x: number, y: number) => void;
}

export function Board({
  tasks,
  projectKey,
  selectedTasks,
  onStatusChange,
  onTaskDrop,
  onTaskClick,
  onTaskSelect,
  onTaskContextMenu,
}: BoardProps) {
  const grouped = TASK_STATUSES.reduce(
    (acc, status) => {
      acc[status] = tasks.filter((t) => t.status === status);
      return acc;
    },
    {} as Record<TaskStatus, ApiTask[]>
  );

  return (
    <div className="relative">
      <div
        className="overflow-x-auto pb-4 overscroll-x-contain"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        <div className="grid grid-cols-6 gap-4 min-w-[1200px]">
          {TASK_STATUSES.map((status) => (
            <Column
              key={status}
              status={status}
              tasks={grouped[status]}
              projectKey={projectKey}
              selectedTasks={selectedTasks}
              onStatusChange={onStatusChange}
              onTaskDrop={onTaskDrop}
              onTaskClick={onTaskClick}
              onTaskSelect={onTaskSelect}
              onTaskContextMenu={onTaskContextMenu}
            />
          ))}
        </div>
      </div>
      {/* Scroll hint fades on edges for small screens */}
      <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-8 bg-gradient-to-r from-bg to-transparent sm:hidden" />
      <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-bg to-transparent sm:hidden" />
    </div>
  );
}
