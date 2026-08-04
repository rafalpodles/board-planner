"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ApiProjectCategory,
  ApiProjectColumn,
  ApiSprint,
  ApiTask,
  ApiCustomField,
  ApiUserSummary,
  PRIORITY_LABELS,
  SortDir,
  SortField,
  SortKey,
  defaultSortDir,
} from "@/types";
import { ListColumnId, isColumnVisible, listColumns as projectListColumns } from "@/lib/list-columns";
import { fieldCellText } from "@/lib/custom-fields";
import { effectiveColumns } from "@/lib/columns";
import { DropEdge, destinationIndex, dropEdge, moveItem } from "@/lib/reorder";
import { Badge } from "@/components/ui/Badge";
import { categoryColor, categoryTint } from "@/lib/category-colors";
import { timeAgo } from "@/lib/time";

interface ListViewProps {
  tasks: ApiTask[];
  projectKey: string;
  projectId?: string;
  sprints?: ApiSprint[];
  categories?: ApiProjectCategory[];
  columns?: ApiProjectColumn[];
  focusedIndex?: number;
  selectedTasks?: Set<string>;
  selectionMode?: boolean;
  /** Owned by the board page, so this and the filter bar cannot disagree */
  sortField?: SortKey;
  sortDir?: SortDir;
  onSortChange?: (field: SortKey, dir: SortDir) => void;
  hiddenColumns?: ListColumnId[];
  customFields?: ApiCustomField[];
  /** Empty for anyone whose user list failed to load; the cell stays read-only */
  assignableUsers?: ApiUserSummary[];
  onTaskClick: (taskId: string) => void;
  onStatusChange?: (taskId: string, status: string) => void;
  onAssigneeChange?: (taskId: string, username: string) => void | Promise<void>;
  onTaskSelect?: (taskId: string) => void;
  onTaskContextMenu?: (taskId: string, x: number, y: number) => void;
  /** Receives every visible row's id in its new order; only reachable under manual sort */
  onReorder?: (orderedIds: string[]) => void;
}

function sprintTiming(sprint: ApiSprint): "active" | "past" | "upcoming" {
  const now = Date.now();
  const start = new Date(sprint.startDate).getTime();
  const end = new Date(sprint.endDate);
  end.setHours(23, 59, 59, 999);
  if (now > end.getTime()) return "past";
  if (now < start) return "upcoming";
  return "active";
}

export function ListView({
  tasks,
  projectKey,
  projectId,
  sprints = [],
  categories = [],
  columns,
  focusedIndex = -1,
  selectedTasks,
  selectionMode,
  sortField = "manual",
  sortDir = "asc",
  onSortChange,
  hiddenColumns = [],
  assignableUsers = [],
  onTaskClick,
  onStatusChange,
  onAssigneeChange,
  onTaskSelect,
  onTaskContextMenu,
  onReorder,
  customFields = [],
}: ListViewProps) {
  const selectionActive = selectionMode || (selectedTasks?.size ?? 0) > 0;
  const show = (id: ListColumnId) => isColumnVisible(id, hiddenColumns);
  const fieldColumns = useMemo(
    () => projectListColumns(customFields).filter((c) => c.field && show(c.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [customFields, hiddenColumns]
  );
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: DropEdge } | null>(
    null,
  );
  const sprintById = useMemo(
    () => new Map(sprints.map((s) => [s._id, s])),
    [sprints],
  );
  const listColumns = useMemo(() => effectiveColumns(columns), [columns]);
  const columnById = useMemo(
    () => new Map(listColumns.map((c) => [c.id, c])),
    [listColumns],
  );

  useEffect(() => {
    if (focusedIndex >= 0 && rowRefs.current[focusedIndex]) {
      rowRefs.current[focusedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [focusedIndex]);

  function handleSort(field: SortKey) {
    if (!onSortChange) return;
    onSortChange(
      field,
      sortField === field
        ? sortDir === "asc"
          ? "desc"
          : "asc"
        : defaultSortDir(field),
    );
  }

  // No local sort: the rows arrive in the order the board page decided
  const sorted = tasks;

  // Any other sort would recompute the order on the next render and throw the drop
  // away, so the handle only appears once the list is showing manual order. The
  // direction matters too: descending manual reverses the rows, which would make a
  // drop reindex them backwards — reachable only from a sort saved before the
  // direction toggle was disabled for manual.
  const canReorder =
    !!onReorder && sortField === "manual" && sortDir === "asc" && sorted.length > 1;

  // The dragged id and the edge both come off the event rather than component state:
  // the browser owns the drag session, and state may not have flushed by drop time.
  // dropTarget drives the indicator only.
  function handleRowDrop(e: React.DragEvent, targetId: string) {
    const sourceId = e.dataTransfer.getData("text/plain") || draggingId;
    const edge = dropEdge(e.clientY, e.currentTarget.getBoundingClientRect());
    const from = sorted.findIndex((t) => t._id === sourceId);
    const target = sorted.findIndex((t) => t._id === targetId);
    setDraggingId(null);
    setDropTarget(null);
    if (from < 0 || target < 0) return;
    const to = destinationIndex(from, target, edge);
    if (from === to) return;
    onReorder?.(moveItem(sorted, from, to).map((t) => t._id));
  }

  function SortHeader({
    label,
    column,
    className,
  }: {
    label: string;
    column: SortKey;
    className?: string;
  }) {
    const active = sortField === column;
    return (
      <th
        // A clickable th is invisible to a keyboard and announces nothing; the
        // button carries the interaction and aria-sort carries the state
        aria-sort={
          active ? (sortDir === "asc" ? "ascending" : "descending") : "none"
        }
        className={`text-left px-2 py-2 font-medium ${className || ""}`}
      >
        <button
          type="button"
          onClick={() => handleSort(column)}
          aria-label={`Sort by ${label}`}
          className="focus-ring inline-flex select-none items-center gap-0.5 rounded font-medium transition-colors hover:text-text"
        >
          {label}
          {active && (
            <svg
              className="w-3 h-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              {sortDir === "asc" ? (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 15l7-7 7 7"
                />
              ) : (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              )}
            </svg>
          )}
        </button>
      </th>
    );
  }

  if (tasks.length === 0) {
    return null;
  }

  return (
    <div className="my-4 border border-border rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-bg-input text-text-muted text-xs border-b border-border">
              {canReorder && <th className="w-6 px-1 py-2" />}
              {selectionActive && <th className="w-8 px-2 py-2" />}
              <SortHeader label="Key" column="key" />
              <SortHeader label="Title" column="title" />
              {show("status") && (
                <SortHeader
                  label="Status"
                  column="status"
                  className="hidden sm:table-cell"
                />
              )}
              {show("assignee") && (
                <SortHeader
                  label="Assignee"
                  column="assignee"
                  className="hidden md:table-cell"
                />
              )}
              {show("priority") && (
                <SortHeader
                  label="Priority"
                  column="priority"
                  className="hidden md:table-cell"
                />
              )}
              {show("sprint") && (
                <SortHeader
                  label="Sprint"
                  column="sprint"
                  className="hidden lg:table-cell"
                />
              )}
              {show("category") && (
                <SortHeader
                  label="Category"
                  column="category"
                  className="hidden lg:table-cell"
                />
              )}
              {show("dueDate") && (
                <SortHeader
                  label="Due"
                  column="dueDate"
                  className="hidden md:table-cell"
                />
              )}
              {show("updatedAt") && (
                <SortHeader
                  label="Updated"
                  column="updatedAt"
                  className="hidden sm:table-cell"
                />
              )}
              {fieldColumns.map((column) => (
                <SortHeader
                  key={column.id}
                  label={column.label}
                  column={column.id}
                  className="hidden lg:table-cell"
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((task, index) => {
              const dueDateInfo = task.dueDate
                ? (() => {
                    const due = new Date(task.dueDate);
                    const now = new Date();
                    now.setHours(0, 0, 0, 0);
                    const diff = Math.ceil(
                      (due.getTime() - now.getTime()) / 86400000,
                    );
                    const color =
                      diff < 0
                        ? "text-danger"
                        : diff <= 2
                          ? "text-warning"
                          : "text-text-muted";
                    return {
                      formatted: due.toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      }),
                      color,
                    };
                  })()
                : null;

              const selected = selectedTasks?.has(task._id) ?? false;
              const catColor = categoryColor(categories, task.category);
              const tinted = !selected && index !== focusedIndex && !!catColor;
              const taskKey = `${projectKey}-${task.taskNumber}`;
              const statusLabel =
                columnById.get(task.status)?.label ?? task.status;
              const assigneeName =
                task.assignee && typeof task.assignee === "object"
                  ? task.assignee.fullName
                  : "—";

              return (
                <tr
                  key={task._id}
                  style={tinted ? categoryTint(catColor) : undefined}
                  ref={(el) => {
                    rowRefs.current[index] = el;
                  }}
                  onClick={(e) => {
                    if (selectionActive || e.ctrlKey || e.metaKey) {
                      e.preventDefault();
                      onTaskSelect?.(task._id);
                    } else {
                      onTaskClick(task._id);
                    }
                  }}
                  onContextMenu={(e) => {
                    if (!onTaskContextMenu) return;
                    e.preventDefault();
                    onTaskContextMenu(task._id, e.clientX, e.clientY);
                  }}
                  onDragOver={(e) => {
                    if (!canReorder || draggingId === task._id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    const edge = dropEdge(
                      e.clientY,
                      e.currentTarget.getBoundingClientRect(),
                    );
                    setDropTarget((current) =>
                      current?.id === task._id && current.edge === edge
                        ? current
                        : { id: task._id, edge },
                    );
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                      setDropTarget((current) =>
                        current?.id === task._id ? null : current,
                      );
                    }
                  }}
                  onDrop={(e) => {
                    if (!canReorder) return;
                    e.preventDefault();
                    handleRowDrop(e, task._id);
                  }}
                  className={`group/row border-b border-border last:border-b-0 cursor-pointer transition-colors ${
                    tinted ? "cat-row" : "hover:bg-bg-input/50"
                  } ${selected ? "bg-primary/10" : ""} ${
                    index === focusedIndex
                      ? "ring-2 ring-primary ring-inset bg-primary/5"
                      : ""
                  } ${draggingId === task._id ? "opacity-40" : ""} ${
                    // An inset shadow on the cells, not a border: it marks the gap the
                    // row will land in without a 2px reflow of the whole table
                    dropTarget?.id === task._id
                      ? dropTarget.edge === "before"
                        ? "[&>td]:shadow-[inset_0_2px_0_0_var(--color-primary)]"
                        : "[&>td]:shadow-[inset_0_-2px_0_0_var(--color-primary)]"
                      : ""
                  }`}
                >
                  {canReorder && (
                    <td className="px-1 py-2 align-middle">
                      {/* The handle is the drag source, not the row: the row opens the
                          task on click and carries inline selects that a draggable
                          ancestor would make awkward to operate */}
                      <span
                        draggable
                        role="button"
                        tabIndex={-1}
                        aria-label={`Reorder ${taskKey}`}
                        title="Drag to reorder"
                        onClick={(e) => e.stopPropagation()}
                        onDragStart={(e) => {
                          setDraggingId(task._id);
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", task._id);
                          const row = rowRefs.current[index];
                          if (row) e.dataTransfer.setDragImage(row, 0, 0);
                        }}
                        onDragEnd={() => {
                          setDraggingId(null);
                          setDropTargetId(null);
                        }}
                        className="flex w-4 cursor-grab select-none justify-center text-text-muted opacity-0 transition-opacity hover:text-text focus-visible:opacity-100 group-hover/row:opacity-100 active:cursor-grabbing"
                      >
                        <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M9 5h2v2H9zm0 6h2v2H9zm0 6h2v2H9zm4-12h2v2h-2zm0 6h2v2h-2zm0 6h2v2h-2z" />
                        </svg>
                      </span>
                    </td>
                  )}
                  {selectionActive && (
                    <td className="px-2 py-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onTaskSelect?.(task._id);
                        }}
                        className={`w-5 h-5 rounded border flex items-center justify-center transition-colors text-[10px]
                          ${
                            selected
                              ? "bg-primary-solid border-primary text-white"
                              : "border-border bg-bg-input text-transparent hover:border-primary/50"
                          }`}
                      >
                        {selected && "✓"}
                      </button>
                    </td>
                  )}
                  <td
                    className="px-2 py-2 font-mono text-xs text-text-muted max-w-24"
                    title={taskKey}
                  >
                    <span className="flex items-center gap-1">
                      {task.pinned && (
                        <svg
                          className="w-3 h-3 shrink-0 text-primary"
                          fill="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2z" />
                        </svg>
                      )}
                      <span className="truncate">{taskKey}</span>
                    </span>
                  </td>
                  <td
                    className="px-2 py-2 font-medium w-full max-w-0"
                    title={task.title}
                  >
                    <div className="truncate min-w-36 sm:min-w-48 lg:min-w-56 2xl:min-w-80">
                      {task.title}
                    </div>
                  </td>
                  {show("status") && (
                    <td className="px-2 py-2 hidden sm:table-cell">
                      {onStatusChange ? (
                        <select
                          value={task.status}
                          title={statusLabel}
                          aria-label={`Status for ${taskKey}: ${task.title}`}
                          onChange={(e) => {
                            e.stopPropagation();
                            onStatusChange(task._id, e.target.value);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="focus-ring text-xs bg-bg-input border border-border rounded px-1.5 py-1 max-w-28 text-text cursor-pointer"
                        >
                          {listColumns.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Badge
                          variant="status"
                          value={task.status}
                          color={columnById.get(task.status)?.color}
                          className="max-w-28"
                        >
                          <span className="truncate" title={statusLabel}>
                            {statusLabel}
                          </span>
                        </Badge>
                      )}
                    </td>
                  )}
                  {show("assignee") && (
                    <td
                      className="px-2 py-2 hidden md:table-cell text-text-muted max-w-32"
                      title={assigneeName}
                    >
                      {onAssigneeChange && assignableUsers.length > 0 ? (
                        <AssigneeCell
                          task={task}
                          taskKey={taskKey}
                          users={assignableUsers}
                          onChange={onAssigneeChange}
                        />
                      ) : (
                        <div className="truncate">{assigneeName}</div>
                      )}
                    </td>
                  )}
                  {show("priority") && (
                    <td className="px-2 py-2 hidden md:table-cell">
                      <Badge variant="priority" value={task.priority}>
                        {PRIORITY_LABELS[task.priority] ?? task.priority}
                      </Badge>
                    </td>
                  )}
                  {show("sprint") && (
                    <td className="px-2 py-2 hidden lg:table-cell text-xs max-w-32">
                      {(() => {
                        const sprint = task.sprint
                          ? sprintById.get(task.sprint)
                          : undefined;
                        if (!sprint)
                          return <span className="text-text-muted">—</span>;
                        const timing = sprintTiming(sprint);
                        const inner = (
                          <span
                            className={`flex items-center gap-1.5 ${
                              timing === "active"
                                ? "font-medium"
                                : "text-text-muted"
                            }`}
                          >
                            {timing === "active" && (
                              <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                            )}
                            <span className="truncate" title={sprint.name}>
                              {sprint.name}
                            </span>
                          </span>
                        );
                        return projectId ? (
                          <Link
                            href={`/projects/${projectId}/sprints`}
                            onClick={(e) => e.stopPropagation()}
                            className="block hover:underline"
                          >
                            {inner}
                          </Link>
                        ) : (
                          inner
                        );
                      })()}
                    </td>
                  )}
                  {show("category") && (
                    <td className="px-2 py-2 hidden lg:table-cell max-w-32">
                      <Badge
                        variant="category"
                        value={task.category}
                        color={catColor}
                        className="max-w-28"
                      >
                        <span className="truncate" title={task.category}>
                          {task.category}
                        </span>
                      </Badge>
                    </td>
                  )}
                  {show("dueDate") && (
                    <td
                      className={`px-2 py-2 hidden md:table-cell text-xs max-w-24 ${dueDateInfo?.color || "text-text-muted"}`}
                    >
                      <div className="truncate">
                        {dueDateInfo?.formatted || "—"}
                      </div>
                    </td>
                  )}
                  {show("updatedAt") && (
                    <td className="px-2 py-2 hidden sm:table-cell text-text-muted text-xs whitespace-nowrap">
                      {timeAgo(task.updatedAt)}
                    </td>
                  )}
                  {fieldColumns.map((column) => {
                    const text = fieldCellText(task.customFieldValues, column.field!);
                    return (
                      <td
                        key={column.id}
                        className="px-2 py-2 hidden lg:table-cell text-text-muted max-w-32"
                        title={text || undefined}
                      >
                        <div className="truncate">{text || "—"}</div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AssigneeCell({
  task,
  taskKey,
  users,
  onChange,
}: {
  task: ApiTask;
  taskKey: string;
  users: ApiUserSummary[];
  onChange: (taskId: string, username: string) => void | Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const current =
    task.assignee && typeof task.assignee === "object" ? task.assignee.username : "";

  // Someone assigned before they lost access is still this task's assignee, and a
  // select whose value is absent from its options silently shows the wrong person
  const options =
    !current || users.some((u) => u.username === current)
      ? users
      : [...users, { _id: current, username: current, fullName: current }];

  return (
    <select
      value={current}
      disabled={saving}
      aria-label={`Assignee for ${taskKey}: ${task.title}`}
      onClick={(e) => e.stopPropagation()}
      onChange={async (e) => {
        e.stopPropagation();
        setSaving(true);
        try {
          await onChange(task._id, e.target.value);
        } finally {
          setSaving(false);
        }
      }}
      className={`focus-ring text-xs bg-bg-input border border-border rounded px-1.5 py-1 max-w-28 text-text cursor-pointer ${
        saving ? "opacity-50" : ""
      }`}
    >
      <option value="">Unassigned</option>
      {options.map((u) => (
        <option key={u._id} value={u.username}>
          {u.fullName}
        </option>
      ))}
    </select>
  );
}
