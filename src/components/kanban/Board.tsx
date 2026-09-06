"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiTask, ApiLabel, ApiCustomField, ApiProjectCategory, ApiProjectColumn } from "@/types";
import { effectiveColumns } from "@/lib/columns";
import { boardGridTemplate, boardMinWidth, isColumnCollapsed } from "@/lib/board-grid";
import {
  pagedColumnAt,
  pagedColumnOffset,
  pagedGridTemplate,
  stepColumn,
  swipeStep,
} from "@/lib/board-swipe";
import { useMediaQuery } from "@/hooks/use-media-query";
import { Column } from "./Column";

interface BoardProps {
  tasks: ApiTask[];
  projectKey: string;
  customFields?: ApiCustomField[];
  projectCategories?: ApiProjectCategory[];
  columns?: ApiProjectColumn[];
  selectedTasks?: Set<string>;
  selectionMode?: boolean;
  collapseEmptyColumns?: boolean;
  onStatusChange?: (taskId: string, status: string) => void;
  onTaskDrop?: (taskId: string, status: string, dropIndex: number) => void;
  onTaskClick: (taskId: string) => void;
  onTaskSelect?: (taskId: string) => void;
  onTaskContextMenu?: (taskId: string, x: number, y: number) => void;
  readOnly?: boolean;
}

export function Board({
  tasks,
  projectKey,
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
  readOnly = false,
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

  const [pinnedColumns, setPinnedColumns] = useState<Set<string>>(new Set());
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

  const paged = useMediaQuery("(max-width: 767px)");
  const collapsed = boardColumns.map((column) =>
    !paged &&
    isColumnCollapsed(
      grouped[column.id].length,
      pinnedColumns.has(column.id),
      dragOverColumn === column.id,
      collapseEmptyColumns
    )
  );

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [activeColumn, setActiveColumn] = useState(0);
  const touchStart = useRef<{ x: number; y: number; furthestDx: number } | null>(null);
  const scrollingTo = useRef<{ target: number; lastLeft: number } | null>(null);

  useEffect(() => {
    setActiveColumn((current) => stepColumn(current, 0, boardColumns.length));
  }, [boardColumns.length]);

  const goToColumn = useCallback(
    (index: number) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const target = stepColumn(index, 0, boardColumns.length);
      setActiveColumn(target);
      const settled =
        scroller.clientWidth <= 0 ||
        pagedColumnAt(scroller.scrollLeft, scroller.clientWidth, boardColumns.length) === target;
      scrollingTo.current = settled ? null : { target, lastLeft: scroller.scrollLeft };
      scroller.scrollTo({
        left: pagedColumnOffset(target, scroller.clientWidth),
        behavior: "smooth",
      });
    },
    [boardColumns.length]
  );

  function handleTouchStart(e: React.TouchEvent) {
    touchStart.current =
      e.touches.length === 1
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY, furthestDx: 0 }
        : null;
  }

  function handleTouchMove(e: React.TouchEvent) {
    const start = touchStart.current;
    if (!start) return;
    if (e.touches.length !== 1) {
      touchStart.current = null;
      return;
    }
    const dx = e.touches[0].clientX - start.x;
    if (Math.abs(dx) > Math.abs(start.furthestDx)) start.furthestDx = dx;
  }

  function handleTouchEnd(e: React.TouchEvent) {
    const start = touchStart.current;
    touchStart.current = null;
    const end = e.changedTouches?.[0];
    if (!start || !end) return;
    const step = swipeStep(end.clientX - start.x, end.clientY - start.y, start.furthestDx || undefined);
    if (step) goToColumn(activeColumn + step);
  }

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const scroller = e.currentTarget;
    const at = pagedColumnAt(scroller.scrollLeft, scroller.clientWidth, boardColumns.length);
    const pending = scrollingTo.current;

    if (pending) {
      if (at === pending.target) {
        scrollingTo.current = null;
        return;
      }
      const goal = pagedColumnOffset(pending.target, scroller.clientWidth);
      if (Math.abs(scroller.scrollLeft - goal) < Math.abs(pending.lastLeft - goal)) {
        pending.lastLeft = scroller.scrollLeft;
        return;
      }
      scrollingTo.current = null;
    }

    setActiveColumn(at);
  }

  return (
    <div className="relative lg:h-full">
      {paged && boardColumns.length > 1 && (
        <div
          role="group"
          aria-label="Board columns"
          className="flex items-center justify-center gap-1 pt-1 md:gap-2 md:pt-3"
        >
          {boardColumns.map((column, i) => (
            <button
              key={column.id}
              type="button"
              onClick={() => goToColumn(i)}
              aria-label={`Show ${column.label}`}
              aria-current={i === activeColumn ? "true" : undefined}
              data-testid={`column-dot-${column.id}`}
              className="focus-ring grid min-h-11 min-w-11 place-items-center rounded-full"
            >
              <span
                aria-hidden="true"
                className={`block h-2 rounded-full transition-all ${
                  i === activeColumn ? "w-6" : "w-2 bg-border"
                }`}
                style={i === activeColumn ? { backgroundColor: column.color } : undefined}
              />
            </button>
          ))}
        </div>
      )}
      <div
        ref={scrollerRef}
        className="overflow-x-auto py-2 overscroll-x-contain md:py-4 lg:h-full"
        style={{
          WebkitOverflowScrolling: "touch",
          ...(paged ? { touchAction: "pan-y pinch-zoom" } : {}),
        }}
        onTouchStart={paged ? handleTouchStart : undefined}
        onTouchMove={paged ? handleTouchMove : undefined}
        onTouchEnd={paged ? handleTouchEnd : undefined}
        onTouchCancel={paged ? () => { touchStart.current = null; } : undefined}
        onScroll={paged ? handleScroll : undefined}
      >
        <div
          className="grid gap-4 lg:h-full lg:grid-rows-[minmax(0,1fr)]"
          style={
            paged
              ? { gridTemplateColumns: pagedGridTemplate(boardColumns.length) }
              : {
                  gridTemplateColumns: boardGridTemplate(collapsed),
                  minWidth: `${boardMinWidth(collapsed)}px`,
                }
          }
        >
          {boardColumns.map((column, i) => (
            <Column
              key={column.id}
              column={column}
              tasks={grouped[column.id]}
              projectKey={projectKey}
              customFields={customFields}
              projectCategories={projectCategories}
              selectedTasks={selectedTasks}
              selectionMode={selectionMode}
              collapsed={collapsed[i]}
              onToggleCollapsed={
                collapseEmptyColumns && !paged
                  ? () =>
                      setPinnedColumns((prev) => {
                        const next = new Set(prev);
                        if (!next.delete(column.id)) next.add(column.id);
                        return next;
                      })
                  : undefined
              }
              onDragOverColumn={
                readOnly
                  ? undefined
                  : (over) =>
                      setDragOverColumn((prev) =>
                        over ? column.id : prev === column.id ? null : prev
                      )
              }
              onStatusChange={readOnly ? undefined : onStatusChange}
              onTaskDrop={onTaskDrop}
              onTaskClick={onTaskClick}
              onTaskSelect={onTaskSelect}
              onTaskContextMenu={onTaskContextMenu}
              readOnly={readOnly}
            />
          ))}
        </div>
      </div>
      <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-8 bg-gradient-to-r from-bg to-transparent sm:hidden" />
      <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-bg to-transparent sm:hidden" />
    </div>
  );
}
