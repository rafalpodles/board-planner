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

  // Expanding a rail is a reading choice, not a preference — it lasts the session
  const [pinnedColumns, setPinnedColumns] = useState<Set<string>>(new Set());
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

  // On a phone the columns are pages: one fills the screen and a flick moves to the next.
  // A rail would be a full-width sliver of vertical text, so nothing collapses here.
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
  // A smooth scroll reports every position on the way, and reading the column off those would
  // answer a second flick with the column the first one started from.
  //
  // `lastLeft` is what makes it recoverable. Waiting only for the target to arrive leaves the
  // guard wedged forever if the animation is interrupted — a field scrolled into view on focus,
  // a URL-bar clamp — and from then on the dots name one column while another is on screen, and
  // the next flick steps from the stale index and skips one.
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
      // A flick at the end of the board asks for the column already on screen, which scrolls
      // nowhere and so would leave a scroll that never arrives to wait for
      const settled =
        scroller.clientWidth <= 0 ||
        pagedColumnAt(scroller.scrollLeft, scroller.clientWidth, boardColumns.length) === target;
      // `clientWidth <= 0` counts as settled: an unlaid-out row can never report arriving, so a
      // guard set here would never clear again for the life of the component.
      scrollingTo.current = settled ? null : { target, lastLeft: scroller.scrollLeft };
      scroller.scrollTo({
        left: pagedColumnOffset(target, scroller.clientWidth),
        behavior: "smooth",
      });
    },
    [boardColumns.length]
  );

  function handleTouchStart(e: React.TouchEvent) {
    // A second finger is a pinch, and its travel says nothing about which column is wanted
    touchStart.current =
      e.touches.length === 1
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY, furthestDx: 0 }
        : null;
  }

  function handleTouchMove(e: React.TouchEvent) {
    const start = touchStart.current;
    if (!start) return;
    // A second finger mid-gesture is a pinch; its travel says nothing about which column is wanted
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
        // Still closing on it: an ordinary frame of the animation
        pending.lastLeft = scroller.scrollLeft;
        return;
      }
      // Stalled or moving away — something other than this animation owns the row now. Let it
      // win rather than holding an indicator that has stopped describing the screen.
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
              // The dot is 8px because that is what reads well; the button around it is 44px
              // because that is what a thumb needs, and it is the pattern the app layout and the
              // settings screens already use. These are the only pointer controls on the mobile
              // board, and at 8px with 8px between them they were the smallest in the app —
              // small enough that WCAG 2.2's spacing exemption does not apply either.
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
        // pt-4 matches pb-4: without it the columns' coloured top border lands on
        // the exact pixel row as the filter bar's divider, reading as one thick line
        className="overflow-x-auto py-2 overscroll-x-contain md:py-4 lg:h-full"
        style={{
          WebkitOverflowScrolling: "touch",
          // Paging owns the horizontal gesture, so the browser must not also pan the row —
          // written out rather than left to Tailwind, whose touch-action utilities replace
          // one another instead of combining
          ...(paged ? { touchAction: "pan-y pinch-zoom" } : {}),
        }}
        onTouchStart={paged ? handleTouchStart : undefined}
        onTouchMove={paged ? handleTouchMove : undefined}
        onTouchEnd={paged ? handleTouchEnd : undefined}
        onTouchCancel={paged ? () => { touchStart.current = null; } : undefined}
        onScroll={paged ? handleScroll : undefined}
      >
        <div
          // The row must be minmax(0,1fr), not auto: an auto row grows to its tallest
          // column, so h-full on the columns resolves against that instead of the
          // viewport and their internal overflow-y never engages.
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
              // Withheld when the preference is off, and on a phone where a column is a
              // page: either way nothing can become a rail, so a collapse control would be
              // a button that does nothing
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
      {/* Scroll hint fades on edges for small screens */}
      <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-8 bg-gradient-to-r from-bg to-transparent sm:hidden" />
      <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-bg to-transparent sm:hidden" />
    </div>
  );
}
