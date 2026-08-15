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
import { fieldCellText, orderedOptions } from "@/lib/custom-fields";
import { effectiveColumns } from "@/lib/columns";
import { CopyTaskLink } from "@/components/tasks/CopyTaskLink";
import {
  DndContext,
  DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { reorderedIds } from "@/lib/reorder";
import { Badge } from "@/components/ui/Badge";
import { Combobox, ComboboxOption } from "@/components/ui/Combobox";
import { categoryColor, categoryTint } from "@/lib/category-colors";
import { timeAgo } from "@/lib/time";
import { RunDot } from "@/components/kanban/RunDot";

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
  /** Each turns its column into a picker; omit one and that cell stays read-only */
  onPriorityChange?: (taskId: string, priority: string) => void;
  onCategoryChange?: (taskId: string, category: string) => void;
  onSprintChange?: (taskId: string, sprintId: string | null) => void;
  onFieldChange?: (taskId: string, fieldId: string, value: string) => void;
}

function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function AssigneeAvatar({ fullName }: { fullName: string }) {
  const label = initials(fullName);
  return (
    <span
      aria-hidden
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
        label
          ? "bg-primary/30 text-text"
          : "border border-dashed border-border text-text-muted"
      }`}
    >
      {label || "–"}
    </span>
  );
}

interface SortableRowState {
  setNodeRef: (el: HTMLElement | null) => void;
  setHandleRef: (el: HTMLElement | null) => void;
  handleProps: Record<string, unknown>;
  style: React.CSSProperties;
  isDragging: boolean;
}

/**
 * Carries useSortable for one row. A render prop rather than a component per row:
 * the row body needs a dozen values from the list, and threading them through props
 * would be a bigger change than the drag itself.
 */
function SortableRow({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled: boolean;
  children: (state: SortableRowState) => React.ReactNode;
}) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } =
    useSortable({ id, disabled });

  return children({
    setNodeRef,
    setHandleRef: setActivatorNodeRef,
    handleProps: { ...attributes, ...listeners },
    style: {
      transform: CSS.Transform.toString(transform),
      transition,
      ...(isDragging ? { position: "relative", zIndex: 1, opacity: 0.85 } : {}),
    },
    isDragging,
  });
}

const PRIORITY_OPTIONS: ComboboxOption[] = Object.entries(PRIORITY_LABELS).map(
  ([value, label]) => ({ value, label })
);

/**
 * A cell whose value comes from a fixed set. Without a handler it renders exactly
 * what it did before, so a column the caller cannot write stays read-only rather
 * than offering a picker that would fail.
 */
function EnumCell({
  value,
  options,
  label,
  onChange,
  children,
}: {
  value: string;
  options: ComboboxOption[];
  label: string;
  onChange?: (next: string) => void;
  children: React.ReactNode;
}) {
  if (!onChange || options.length === 0) return <>{children}</>;
  return (
    <Combobox
      value={value}
      options={options}
      onChange={onChange}
      label={label}
      triggerClassName="w-full rounded"
    >
      {() => children}
    </Combobox>
  );
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
  onPriorityChange,
  onCategoryChange,
  onSprintChange,
  onFieldChange,
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

  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so clicking the grip stays a click
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over) return;
    const next = reorderedIds(
      sorted.map((t) => t._id),
      String(active.id),
      String(over.id),
    );
    if (next) onReorder?.(next);
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
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      // The rows only ever move up and down, and never out of the table
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
    >
    <SortableContext
      items={sorted.map((t) => t._id)}
      strategy={verticalListSortingStrategy}
    >
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
                  className="hidden sm:table-cell min-w-28"
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
                <SortableRow key={task._id} id={task._id} disabled={!canReorder}>
                  {({ setNodeRef, setHandleRef, handleProps, style }) => (
                <tr
                  style={{ ...(tinted ? categoryTint(catColor) : {}), ...style }}
                  ref={(el) => {
                    rowRefs.current[index] = el;
                    setNodeRef(el);
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
                  className={`group/row border-b border-border last:border-b-0 transition-colors ${
                    tinted ? "cat-row" : "hover:bg-bg-input/50"
                  } ${selected ? "bg-primary/10" : ""} ${
                    index === focusedIndex
                      ? "ring-2 ring-primary ring-inset bg-primary/5"
                      : ""
                  }`}
                >
                  {canReorder && (
                    <td className="px-1 py-2 align-middle">
                      {/* The handle is the drag source, not the row: the row opens the
                          task on click and carries inline selects that a draggable
                          ancestor would make awkward to operate */}
                      <button
                        type="button"
                        ref={setHandleRef}
                        aria-label={`Reorder ${taskKey}`}
                        title="Drag to reorder"
                        onClick={(e) => e.stopPropagation()}
                        {...handleProps}
                        className="focus-ring flex w-4 cursor-grab touch-none select-none justify-center text-text-muted opacity-0 transition-opacity hover:text-text focus-visible:opacity-100 group-hover/row:opacity-100 active:cursor-grabbing"
                      >
                        <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M9 5h2v2H9zm0 6h2v2H9zm0 6h2v2H9zm4-12h2v2h-2zm0 6h2v2h-2zm0 6h2v2h-2z" />
                        </svg>
                      </button>
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
                    <span className="flex items-center gap-1.5">
                      <span className="truncate">{taskKey}</span>
                      <CopyTaskLink
                        projectRef={projectKey}
                        taskNumber={task.taskNumber}
                        taskKey={taskKey}
                      />
                      <RunDot execution={task.execution} />
                    </span>
                  </td>
                  <td
                    // overflow-hidden on the cell too: the column can be squeezed
                    // narrower than the title's min width, and the div alone would
                    // then paint its overflow across the next cell
                    // The pointer lives on the title alone: the row opens the task,
                    // but a hand over the selects and the drag grip reads as wrong
                    className="px-2 py-2 font-medium w-full max-w-0 overflow-hidden cursor-pointer"
                    title={task.title}
                  >
                    {/* No min-width: it would be a floor the table cannot go under,
                        which is what forced the whole list to scroll sideways */}
                    <div className="truncate w-full">{task.title}</div>
                  </td>
                  {show("status") && (
                    <td className="px-2 py-2 hidden sm:table-cell">
                      {onStatusChange ? (
                        <Combobox
                          value={task.status}
                          options={listColumns.map((c) => ({
                            value: c.id,
                            label: c.label,
                            color: c.color,
                          }))}
                          onChange={(next) => onStatusChange(task._id, next)}
                          label={`Status for ${taskKey}: ${task.title}`}
                          triggerClassName="w-full rounded"
                        >
                          {(selected) => (
                            <Badge
                              variant="status"
                              value={task.status}
                              color={columnById.get(task.status)?.color}
                              className="w-full"
                            >
                              <span className="truncate" title={statusLabel}>
                                {selected?.label ?? statusLabel}
                              </span>
                            </Badge>
                          )}
                        </Combobox>
                      ) : (
                        <Badge
                          variant="status"
                          value={task.status}
                          color={columnById.get(task.status)?.color}
                          className="w-full"
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
                      className="px-2 py-2 hidden md:table-cell text-text-muted"
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
                        <AssigneeAvatar
                          fullName={assigneeName === "—" ? "" : assigneeName}
                        />
                      )}
                    </td>
                  )}
                  {show("priority") && (
                    <td className="px-2 py-2 hidden md:table-cell">
                      <EnumCell
                        value={task.priority}
                        options={PRIORITY_OPTIONS}
                        label={`Priority for ${taskKey}: ${task.title}`}
                        onChange={
                          onPriorityChange && ((next) => onPriorityChange(task._id, next))
                        }
                      >
                        <Badge variant="priority" value={task.priority} className="w-full">
                          <span className="truncate">
                            {PRIORITY_LABELS[task.priority] ?? task.priority}
                          </span>
                        </Badge>
                      </EnumCell>
                    </td>
                  )}
                  {show("sprint") && (
                    <td className="px-2 py-2 hidden lg:table-cell text-xs max-w-32">
                      <EnumCell
                        value={task.sprint ?? ""}
                        options={[
                          { value: "", label: "No sprint" },
                          ...sprints.map((s) => ({ value: s._id, label: s.name })),
                        ]}
                        label={`Sprint for ${taskKey}: ${task.title}`}
                        onChange={
                          onSprintChange &&
                          ((next) => onSprintChange(task._id, next || null))
                        }
                      >
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
                        // The picker replaces the link to the sprints page: one cell
                        // cannot be both, and changing the sprint is the commoner act
                        if (onSprintChange) return inner;
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
                      </EnumCell>
                    </td>
                  )}
                  {show("category") && (
                    <td className="px-2 py-2 hidden lg:table-cell max-w-32">
                      <EnumCell
                        value={task.category}
                        options={categories.map((c) => ({
                          value: c.name,
                          label: c.name,
                          color: c.color,
                        }))}
                        label={`Category for ${taskKey}: ${task.title}`}
                        onChange={
                          onCategoryChange && ((next) => onCategoryChange(task._id, next))
                        }
                      >
                        <Badge
                          variant="category"
                          value={task.category}
                          color={catColor}
                          className="w-full"
                        >
                          <span className="truncate" title={task.category}>
                            {task.category}
                          </span>
                        </Badge>
                      </EnumCell>
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
                    const field = column.field!;
                    const text = fieldCellText(task.customFieldValues, field);
                    // orderedOptions, not field.options: it sorts them and gives the
                    // legacy string form the same {id, value, color} shape
                    const options = orderedOptions(field);
                    const raw = task.customFieldValues?.[field._id];
                    // The stored value is the option's id, never its label — the label
                    // is what validateCustomFieldValues rejects
                    const chosen = Array.isArray(raw)
                      ? raw.map(String)
                      : raw === undefined || raw === null || raw === ""
                        ? []
                        : [String(raw)];
                    // Only single-choice fields: a multiselect needs a control that
                    // can hold several values, which this picker cannot
                    const choices =
                      field.fieldType === "dropdown"
                        ? [
                            { value: "", label: "—" },
                            ...options.map((o) => ({
                              value: o.id,
                              label: o.value,
                              color: o.color,
                            })),
                          ]
                        : [];
                    const picked = chosen
                      .map((id) => options.find((o) => o.id === id))
                      .filter((o): o is (typeof options)[number] => !!o);
                    return (
                      <td
                        key={column.id}
                        className="px-2 py-2 hidden lg:table-cell text-text-muted max-w-32"
                        title={text || undefined}
                      >
                        <EnumCell
                          value={chosen[0] ?? ""}
                          options={choices}
                          label={`${field.name} for ${taskKey}: ${task.title}`}
                          onChange={
                            onFieldChange &&
                            ((next) => onFieldChange(task._id, field._id, next))
                          }
                        >
                          {picked.length > 0 ? (
                            <span className="flex flex-wrap items-center gap-1">
                              {picked.map((option) => (
                                <Badge
                                  key={option.id}
                                  color={option.color}
                                  className="max-w-full"
                                >
                                  <span className="truncate">{option.value}</span>
                                </Badge>
                              ))}
                            </span>
                          ) : (
                            <div className="truncate">{text || "—"}</div>
                          )}
                        </EnumCell>
                      </td>
                    );
                  })}
                </tr>
                  )}
                </SortableRow>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
    </SortableContext>
    </DndContext>
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

  const fullName =
    task.assignee && typeof task.assignee === "object" ? task.assignee.fullName : "";

  return (
    <Combobox
      value={current}
      options={[
        { value: "", label: "Unassigned" },
        ...options.map((u) => ({ value: u.username, label: u.fullName })),
      ]}
      onChange={async (next) => {
        setSaving(true);
        try {
          await onChange(task._id, next);
        } finally {
          setSaving(false);
        }
      }}
      label={`Assignee for ${taskKey}: ${task.title}`}
      disabled={saving}
      // The avatar is small and otherwise reads as a static badge; the ring is what
      // says it opens something
      triggerClassName={`rounded-full transition hover:ring-2 hover:ring-primary/40 ${
        saving ? "opacity-50" : ""
      }`}
    >
      {() => <AssigneeAvatar fullName={fullName} />}
    </Combobox>
  );
}
