"use client";

import { useMemo } from "react";
import { ApiTask, ApiLabel, ApiProjectCategory, ApiProjectColumn } from "@/types";
import { effectiveColumns } from "@/lib/columns";
import { Column } from "./Column";

interface BoardProps {
  tasks: ApiTask[];
  projectKey: string;
  projectLabels?: ApiLabel[];
  projectCategories?: ApiProjectCategory[];
  columns?: ApiProjectColumn[];
  selectedTasks?: Set<string>;
  selectionMode?: boolean;
  onStatusChange: (taskId: string, status: string) => void;
  onTaskDrop?: (taskId: string, status: string, dropIndex: number) => void;
  onTaskClick: (taskId: string) => void;
  onTaskSelect?: (taskId: string) => void;
  onTaskContextMenu?: (taskId: string, x: number, y: number) => void;
}

export function Board({
  tasks,
  projectKey,
  projectLabels,
  projectCategories,
  columns,
  selectedTasks,
  selectionMode,
  onStatusChange,
  onTaskDrop,
  onTaskClick,
  onTaskSelect,
  onTaskContextMenu,
}: BoardProps) {
  const boardColumns = useMemo(() => effectiveColumns(columns), [columns]);
  const grouped = useMemo(
    () =>
      boardColumns.reduce(
        (acc, column) => {
          acc[column.id] = tasks.filter((t) => t.status === column.id);
          return acc;
        },
        {} as Record<string, ApiTask[]>
      ),
    [tasks, boardColumns]
  );

  return (
    <div className="relative lg:h-full">
      <div
        className="overflow-x-auto pb-4 overscroll-x-contain lg:h-full"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        <div
          // The row must be minmax(0,1fr), not auto: an auto row grows to its tallest
          // column, so h-full on the columns resolves against that instead of the
          // viewport and their internal overflow-y never engages.
          className="grid gap-4 lg:h-full lg:grid-rows-[minmax(0,1fr)]"
          style={{
            gridTemplateColumns: `repeat(${boardColumns.length}, minmax(0, 1fr))`,
            minWidth: `${boardColumns.length * 200}px`,
          }}
        >
          {boardColumns.map((column) => (
            <Column
              key={column.id}
              column={column}
              tasks={grouped[column.id]}
              projectKey={projectKey}
              projectLabels={projectLabels}
              projectCategories={projectCategories}
              selectedTasks={selectedTasks}
              selectionMode={selectionMode}
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
