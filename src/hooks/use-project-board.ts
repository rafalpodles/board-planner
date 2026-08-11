"use client";

import { Dispatch, SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { usePollWhileVisible } from "@/hooks/use-poll-while-visible";
import { ApiProject, ApiSprint, ApiTask, ApiUserSummary, RunConflict } from "@/types";
import { subscribeBoardRefresh } from "@/lib/board-refresh";
import { useToast } from "@/components/ui/Toast";

export interface ProjectBoard {
  project: ApiProject | null;
  tasks: ApiTask[];
  sprints: ApiSprint[];
  assignableUsers: ApiUserSummary[];
  loading: boolean;
  // True after the most recent load attempt failed; cleared by the next attempt that
  // succeeds. The page only acts on this when there is nothing else to show — a poll
  // failing once the board is already up leaves the last good state on screen instead.
  loadError: boolean;
  reload: () => Promise<void>;
  viewMode: "board" | "list";
  setViewMode: (mode: "board" | "list") => void;
  showNewTask: boolean;
  setShowNewTask: (open: boolean) => void;
  // Passed straight back: null is "no sprint resolved yet", never the unscoped board
  scope: string | null;
  // The scope `tasks` were loaded for. undefined, never null, until a task list has arrived:
  // null is itself a scope, and matching it would read as "loaded" before anything was asked for
  loadedScope: string | undefined;
  selectedTasks: Set<string>;
  setSelectedTasks: Dispatch<SetStateAction<Set<string>>>;
  selectionMode: boolean;
  setSelectionMode: Dispatch<SetStateAction<boolean>>;
  confirmBulkDelete: boolean;
  setConfirmBulkDelete: (open: boolean) => void;
  bulkDeleting: boolean;
  confirmContextDelete: string | null;
  setConfirmContextDelete: (taskId: string | null) => void;
  heldMove: { retry: () => Promise<unknown>; conflict: RunConflict; taskKey: string } | null;
  setHeldMove: (held: ProjectBoard["heldMove"]) => void;
  forceHeldMove: () => Promise<void>;
  handleStatusChange: (taskId: string, status: string) => Promise<void>;
  handleTaskDrop: (taskId: string, status: string, dropIndex: number) => Promise<void>;
  handleReorder: (orderedIds: string[]) => Promise<void>;
  handleBulkMove: (status: string) => Promise<void>;
  handleBulkSprint: (sprintId: string | null) => Promise<void>;
  handleBulkDelete: () => Promise<void>;
  applySprintChange: (taskIds: string[], sprintId: string | null) => void;
  patchTask: (taskId: string, patch: Record<string, unknown>, label: string) => Promise<void>;
  handleAssigneeChange: (taskId: string, username: string) => Promise<void>;
  handleFieldValueChange: (taskId: string, fieldId: string, value: string) => Promise<void>;
  handleRowSprintChange: (taskId: string, sprintId: string | null) => Promise<void>;
  handleContextDuplicate: (taskId: string) => Promise<void>;
  handleContextDelete: (taskId: string) => Promise<void>;
}

// "relates" is symmetric and "duplicates" has a readable inverse, so a card should
// show a relation regardless of which side created it. Every task is already loaded,
// so the reverse side is derived here instead of costing another request.
function withIncomingRelations(tasks: ApiTask[]): ApiTask[] {
  const incoming = new Map<string, ApiTask["relatedFrom"]>();
  for (const task of tasks) {
    for (const relation of task.relations || []) {
      const targetId = relation.task?._id;
      if (!targetId) continue;
      const entry = {
        type: relation.type,
        task: {
          _id: task._id,
          taskNumber: task.taskNumber,
          title: task.title,
          status: task.status,
        },
      };
      incoming.set(targetId, [...(incoming.get(targetId) || []), entry]);
    }
  }
  return tasks.map((task) => ({ ...task, relatedFrom: incoming.get(task._id) || [] }));
}

// A null scope means the caller cannot say yet which sprint it wants — the project and the
// sprint list still load, the tasks request is skipped rather than fired at an unresolved id.
export function useProjectBoard(projectId: string, scope: string | null): ProjectBoard {
  const api = useApi();
  const { toast } = useToast();

  const [project, setProject] = useState<ApiProject | null>(null);
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [showNewTask, setShowNewTask] = useState(false);
  const loadSeq = useRef(0);
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  // A move the server refused because a worker holds the task, parked until the person decides.
  // Carries the retry rather than a request body: the board reaches the same refusal through two
  // different endpoints, and both have to offer the same way out.
  const [heldMove, setHeldMove] = useState<ProjectBoard["heldMove"]>(null);
  const [confirmContextDelete, setConfirmContextDelete] = useState<string | null>(null);

  const [viewMode, setViewModeState] = useState<"board" | "list">(() => {
    if (typeof window === "undefined") return "board";
    return localStorage.getItem(`view-mode:${projectId}`) === "list" ? "list" : "board";
  });
  const [sprints, setSprints] = useState<ApiSprint[]>([]);
  const [loadedScope, setLoadedScope] = useState<string | undefined>(undefined);
  const [assignableUsers, setAssignableUsers] = useState<ApiUserSummary[]>([]);

  const setViewMode = useCallback(
    (mode: "board" | "list") => {
      setViewModeState(mode);
      localStorage.setItem(`view-mode:${projectId}`, mode);
    },
    [projectId]
  );

  const loadData = useCallback(async () => {
    const seq = ++loadSeq.current;
    // The scope this request was issued for, so what lands is never labelled with a scope
    // chosen after it left
    const requestScope = scope;
    try {
      const sprintParam =
        requestScope && requestScope !== "all" ? `?sprint=${requestScope}` : "";
      const [proj, taskList, sprintList] = await Promise.all([
        api.get(`/api/projects/${projectId}`),
        requestScope === null
          ? Promise.resolve(null)
          : api.get(`/api/projects/${projectId}/tasks${sprintParam}`),
        api.get(`/api/projects/${projectId}/sprints`),
      ]);
      // A slower earlier request must not overwrite what a later one already applied,
      // nor report that loading finished — it never applied anything, it was overtaken
      if (seq !== loadSeq.current) return;
      setProject(proj);
      if (requestScope !== null) {
        setTasks(withIncomingRelations(taskList));
        setLoadedScope(requestScope);
      } else {
        setTasks([]);
      }
      setSprints(sprintList);
      setLoadError(false);
    } catch {
      if (seq !== loadSeq.current) return;
      setLoadError(true);
      toast("Failed to load board data", "error");
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, scope]);

  // Once, not on the board poll: the roster does not change while you work
  useEffect(() => {
    api.get("/api/users/list").then(setAssignableUsers).catch(() => setAssignableUsers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  usePollWhileVisible(loadData, 10_000);

  // Instant refresh when the PM chat reports a write action (poll stays as fallback).
  // Bursts are coalesced inside subscribeBoardRefresh.
  useEffect(() => subscribeBoardRefresh(projectId, loadData), [projectId, loadData]);

  async function handleBulkMove(status: string) {
    const ids = Array.from(selectedTasks);
    // Settled, not all: one task held by a worker used to reject the whole batch while the others
    // had already moved server-side, leaving the board saying nothing worked when most of it had.
    const outcomes = await Promise.allSettled(
      ids.map((id) => api.patch(`/api/projects/${projectId}/tasks/${id}/status`, { status }))
    );

    const movedIds = new Set(ids.filter((_, i) => outcomes[i].status === "fulfilled"));
    const held = outcomes
      .map((outcome, i) => ({ outcome, id: ids[i] }))
      .filter(({ outcome }) => {
        if (outcome.status !== "rejected") return false;
        const failure = outcome.reason as { status?: number; body?: { runConflict?: unknown } };
        return failure?.status === 409 && !!failure.body?.runConflict;
      })
      .map(({ id }) => tasks.find((t) => t._id === id)?.taskNumber)
      .filter(Boolean);

    setTasks((prev) =>
      prev.map((t) => (movedIds.has(t._id) ? { ...t, status: status as ApiTask["status"] } : t))
    );
    setSelectedTasks(new Set());

    if (movedIds.size === ids.length) {
      toast(`Moved ${ids.length} task${ids.length === 1 ? "" : "s"}`, "success");
    } else if (held.length > 0) {
      // Names them: "some failed" leaves the person hunting for which, on a board where the only
      // other clue is a card that looks much like its neighbours
      const names = held.map((n) => `${project?.key}-${n}`).join(", ");
      toast(`Moved ${movedIds.size} of ${ids.length}. ${names} being executed by a worker.`, "error");
    } else {
      toast(`Moved ${movedIds.size} of ${ids.length}`, "error");
    }
  }

  async function handleBulkSprint(sprintId: string | null) {
    const ids = Array.from(selectedTasks);
    try {
      await Promise.all(
        ids.map((id) =>
          api.put(`/api/projects/${projectId}/tasks/${id}`, { sprint: sprintId })
        )
      );
      applySprintChange(ids, sprintId);
      setSelectedTasks(new Set());
      const target = sprintId
        ? sprints.find((s) => s._id === sprintId)?.name ?? "sprint"
        : "backlog";
      toast(`Moved ${ids.length} task${ids.length === 1 ? "" : "s"} to ${target}`, "success");
    } catch {
      toast("Failed to move tasks to sprint", "error");
    }
  }

  // Tasks leaving the sprint the board is filtered by must disappear from it
  function applySprintChange(taskIds: string[], sprintId: string | null) {
    const affected = new Set(taskIds);
    setTasks((prev) => {
      const updated = prev.map((t) =>
        affected.has(t._id) ? { ...t, sprint: sprintId } : t
      );
      if (scope === "all") return updated;
      const wanted = scope === "backlog" ? null : scope;
      return updated.filter((t) => !affected.has(t._id) || t.sprint === wanted);
    });
  }

  async function handleBulkDelete() {
    setBulkDeleting(true);
    try {
      await Promise.all(
        Array.from(selectedTasks).map((id) =>
          api.del(`/api/projects/${projectId}/tasks/${id}`)
        )
      );
      setTasks((prev) => prev.filter((t) => !selectedTasks.has(t._id)));
      const count = selectedTasks.size;
      setSelectedTasks(new Set());
      setConfirmBulkDelete(false);
      toast(`Deleted ${count} task${count === 1 ? "" : "s"}`, "success");
    } catch {
      toast("Failed to delete tasks", "error");
    } finally {
      setBulkDeleting(false);
    }
  }

  async function handleAssigneeChange(taskId: string, username: string) {
    try {
      // PUT, not PATCH: the task route exposes GET/PUT/DELETE, and updateTask
      // copies only the fields present in the body, so this stays a partial update.
      // null, not "": task-service only resolves a non-empty string, so "" would
      // reach Mongoose as a cast error instead of clearing the field
      const updated = await api.put(`/api/projects/${projectId}/tasks/${taskId}`, {
        assignee: username || null,
      });
      setTasks((prev) =>
        prev.map((t) => (t._id === taskId ? { ...t, assignee: updated.assignee } : t))
      );
    } catch {
      toast("Failed to update assignee", "error");
    }
  }

  // A refusal because a worker holds the task is not a failure to report — it is a question to
  // ask. Returns true when it parked one, so the caller skips its own error handling.
  function parkIfHeld(err: unknown, taskId: string, retry: () => Promise<unknown>): boolean {
    const failure = err as { status?: number; body?: { runConflict?: RunConflict } };
    if (failure?.status !== 409 || !failure.body?.runConflict) return false;
    const task = tasks.find((t) => t._id === taskId);
    setHeldMove({
      retry,
      conflict: failure.body.runConflict,
      taskKey: `${project?.key}-${task?.taskNumber}`,
    });
    return true;
  }

  async function handleStatusChange(taskId: string, status: string) {
    const patch = (force?: boolean) =>
      api.patch(`/api/projects/${projectId}/tasks/${taskId}/status`, {
        status,
        ...(force ? { force: true } : {}),
      });
    try {
      await patch();
      setTasks((prev) =>
        prev.map((t) =>
          t._id === taskId ? { ...t, status: status as ApiTask["status"] } : t
        )
      );
    } catch (err) {
      if (parkIfHeld(err, taskId, () => patch(true))) return;
      toast("Failed to update status", "error");
    }
  }

  async function handleTaskDrop(taskId: string, status: string, dropIndex: number) {
    // Get tasks in the target column, excluding the dragged task
    const columnTasks = tasks
      .filter((t) => t.status === status && t._id !== taskId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    let newOrder: number;
    if (columnTasks.length === 0) {
      newOrder = 0;
    } else if (dropIndex <= 0) {
      newOrder = (columnTasks[0].order ?? 0) - 1;
    } else if (dropIndex >= columnTasks.length) {
      newOrder = (columnTasks[columnTasks.length - 1].order ?? 0) + 1;
    } else {
      const before = columnTasks[dropIndex - 1].order ?? 0;
      const after = columnTasks[dropIndex].order ?? 0;
      newOrder = (before + after) / 2;
    }

    // Optimistic update
    setTasks((prev) =>
      prev.map((t) =>
        t._id === taskId
          ? { ...t, status: status as ApiTask["status"], order: newOrder }
          : t
      )
    );

    const moved = tasks.find((t) => t._id === taskId);
    const body = {
      order: newOrder,
      // Status only when it actually changes: a drop inside the same column is a
      // reorder, and sending the status it already has would stamp updatedAt and
      // release the task from any run a worker is holding it for
      ...(moved?.status === status ? {} : { status }),
    };

    try {
      await api.put(`/api/projects/${projectId}/tasks/${taskId}`, body);
    } catch (err) {
      // A worker is running this task. Ask rather than silently taking it off the machine —
      // the optimistic move is rolled back either way, by confirming or by loadData below.
      const retry = () =>
        api.put(`/api/projects/${projectId}/tasks/${taskId}`, { ...body, force: true });
      if (parkIfHeld(err, taskId, retry)) return;
      toast("Failed to move task", "error");
      loadData();
    }
  }

  async function forceHeldMove() {
    if (!heldMove) return;
    const pending = heldMove;
    setHeldMove(null);
    try {
      await pending.retry();
      toast(`${pending.taskKey} taken from the worker`, "success");
    } catch {
      toast("Failed to move task", "error");
    }
    loadData();
  }

  // The list hands back only the rows it shows, so a filtered list reindexes just
  // those; tasks hidden by a filter keep the order they already had
  async function handleReorder(orderedIds: string[]) {
    const rank = new Map(orderedIds.map((id, index) => [id, index]));
    setTasks((prev) =>
      prev.map((t) => (rank.has(t._id) ? { ...t, order: rank.get(t._id)! } : t))
    );

    try {
      await api.put(`/api/projects/${projectId}/tasks/reorder`, { order: orderedIds });
    } catch {
      toast("Failed to reorder tasks", "error");
      // The server renumbers across the whole project, so only it knows the result
      loadData();
    }
  }

  // One writer for every inline enum cell: they differ only in which field they set
  // Reverts the fields it touched on the one task, rather than restoring a whole
  // snapshot: the 10s poll and any concurrent edit land in between, and putting the
  // old array back would throw their results away too
  async function patchTask(taskId: string, patch: Record<string, unknown>, label: string) {
    const before = tasks.find((t) => t._id === taskId);
    setTasks((prev) => prev.map((t) => (t._id === taskId ? { ...t, ...patch } : t)));
    try {
      await api.put(`/api/projects/${projectId}/tasks/${taskId}`, patch);
    } catch {
      toast(`Failed to update ${label}`, "error");
      if (!before) return;
      const revert = Object.fromEntries(
        Object.keys(patch).map((key) => [key, before[key as keyof ApiTask]])
      );
      setTasks((prev) => prev.map((t) => (t._id === taskId ? { ...t, ...revert } : t)));
    }
  }

  async function handleFieldValueChange(taskId: string, fieldId: string, value: string) {
    const task = tasks.find((t) => t._id === taskId);
    if (!task) return;
    const values = { ...(task.customFieldValues || {}), [fieldId]: value };
    await patchTask(taskId, { customFieldValues: values }, "field");
  }

  async function handleRowSprintChange(taskId: string, sprintId: string | null) {
    // Not patchTask: a task leaving the sprint the board is filtered by has to drop
    // out of the list, which applySprintChange already knows how to do
    applySprintChange([taskId], sprintId);
    try {
      await api.put(`/api/projects/${projectId}/tasks/${taskId}`, { sprint: sprintId });
    } catch {
      toast("Failed to update sprint", "error");
      // A removed row cannot be put back by patching it, and the server is the only
      // thing that still knows what the scope should contain
      loadData();
    }
  }

  async function handleContextDuplicate(taskId: string) {
    const task = tasks.find((t) => t._id === taskId);
    if (!task) return;
    try {
      // No status: columns are per project since CP-128, so a literal "planned" is a 400
      // in any project that renamed or rebuilt its board
      await api.post(`/api/projects/${projectId}/tasks`, {
        title: `Copy of ${task.title}`,
        description: task.description,
        priority: task.priority,
        category: task.category,
        checklist: task.checklist,
        dueDate: task.dueDate,
        customFieldValues: task.customFieldValues,
      });
      toast("Task duplicated", "success");
      loadData();
    } catch {
      toast("Failed to duplicate task", "error");
    }
  }

  async function handleContextDelete(taskId: string) {
    try {
      await api.del(`/api/projects/${projectId}/tasks/${taskId}`);
      setTasks((prev) => prev.filter((t) => t._id !== taskId));
      toast("Task deleted", "success");
    } catch {
      toast("Failed to delete task", "error");
    } finally {
      setConfirmContextDelete(null);
    }
  }

  return {
    project,
    tasks,
    sprints,
    assignableUsers,
    loading,
    loadError,
    reload: loadData,
    viewMode,
    setViewMode,
    showNewTask,
    setShowNewTask,
    scope,
    loadedScope,
    selectedTasks,
    setSelectedTasks,
    selectionMode,
    setSelectionMode,
    confirmBulkDelete,
    setConfirmBulkDelete,
    bulkDeleting,
    confirmContextDelete,
    setConfirmContextDelete,
    heldMove,
    setHeldMove,
    forceHeldMove,
    handleStatusChange,
    handleTaskDrop,
    handleReorder,
    handleBulkMove,
    handleBulkSprint,
    handleBulkDelete,
    applySprintChange,
    patchTask,
    handleAssigneeChange,
    handleFieldValueChange,
    handleRowSprintChange,
    handleContextDuplicate,
    handleContextDelete,
  };
}
