"use client";

import { useMemo, useState } from "react";
import { ApiTask, ApiLabel, ApiCustomField, ApiProjectCategory, ApiProjectColumn } from "@/types";
import { effectiveColumns } from "@/lib/columns";
import { boardGridTemplate, boardMinWidth, isColumnCollapsed } from "@/lib/board-grid";
import { Column } from "./Column";

interface BoardProps {
  tasks: ApiTask[];
  projectKey: string;
  projectLabels?: ApiLabel[];
  customFields?: ApiCustomField[];
  projectCategories?: ApiProjectCategory[];
  columns?: ApiProjectColumn[];
  selectedTasks?: Set<string>;
  selectionMode?: boolean;
  collapseEmptyColumns?: boolean;
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
  customFields,
  projectCategories,
  columns,
  selectedTasks,
  selectionMode,
  collapseEmptyColumns = true,
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

  // Expanding a rail is a reading choice, not a preference — it lasts the session
  const [pinnedColumns, setPinnedColumns] = useState<Set<string>>(new Set());
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

  const collapsed = boardColumns.map((column) =>
    isColumnCollapsed(
      grouped[column.id].length,
      pinnedColumns.has(column.id),
      dragOverColumn === column.id,
      collapseEmptyColumns
    )
  );

  return (
    <div className="relative lg:h-full">
      <div
        // pt-4 matches pb-4: without it the columns' coloured top border lands on
        // the exact pixel row as the filter bar's divider, reading as one thick line
        className="overflow-x-auto py-4 overscroll-x-contain lg:h-full"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        <div
          // The row must be minmax(0,1fr), not auto: an auto row grows to its tallest
          // column, so h-full on the columns resolves against that instead of the
          // viewport and their internal overflow-y never engages.
          className="grid gap-4 lg:h-full lg:grid-rows-[minmax(0,1fr)]"
          style={{
            gridTemplateColumns: boardGridTemplate(collapsed),
            minWidth: `${boardMinWidth(collapsed)}px`,
          }}
        >
          {boardColumns.map((column, i) => (
            <Column
              key={column.id}
              column={column}
              tasks={grouped[column.id]}
              projectKey={projectKey}
              projectLabels={projectLabels}
              customFields={customFields}
              projectCategories={projectCategories}
              selectedTasks={selectedTasks}
              selectionMode={selectionMode}
              collapsed={collapsed[i]}
              // Withheld when the preference is off: nothing can become a rail,
              // so a collapse control would be a button that does nothing
              onToggleCollapsed={
                collapseEmptyColumns
                  ? () =>
                      setPinnedColumns((prev) => {
                        const next = new Set(prev);
                        if (!next.delete(column.id)) next.add(column.id);
                        return next;
                      })
                  : undefined
              }
              onDragOverColumn={(over) =>
                setDragOverColumn((prev) =>
                  over ? column.id : prev === column.id ? null : prev
                )
              }
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
