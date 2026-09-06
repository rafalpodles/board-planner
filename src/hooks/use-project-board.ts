"use client";

import { Dispatch, SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { usePollWhileVisible } from "@/hooks/use-poll-while-visible";
import { ApiProject, ApiSprint, ApiTask, ApiUserSummary, RunConflict } from "@/types";
import { subscribeBoardRefresh } from "@/lib/board-refresh";
import { duplicatePayload } from "@/lib/task-duplicate";
import { useToast } from "@/components/ui/Toast";

export interface ProjectBoard {
  project: ApiProject | null;
  tasks: ApiTask[];
  sprints: ApiSprint[];
  assignableUsers: ApiUserSummary[];
  loading: boolean;
  loadError: boolean;
  reload: () => Promise<void>;
  viewMode: "board" | "list";
  setViewMode: (mode: "board" | "list") => void;
  showNewTask: boolean;
  setShowNewTask: (open: boolean) => void;
  scope: string | null;
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
  deleting: boolean;
  heldMove: { retry: () => Promise<unknown>; conflict: RunConflict; taskKey: string } | null;
  setHeldMove: (held: ProjectBoard["heldMove"]) => void;
  forceHeldMove: () => Promise<void>;
  heldDelete: { retry: () => Promise<unknown>; conflict: RunConflict; taskKey: string } | null;
  setHeldDelete: (held: ProjectBoard["heldDelete"]) => void;
  forceHeldDelete: () => Promise<void>;
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
  const [heldMove, setHeldMove] = useState<ProjectBoard["heldMove"]>(null);
  const [heldDelete, setHeldDelete] = useState<ProjectBoard["heldDelete"]>(null);
  const [confirmContextDelete, setConfirmContextDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

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

  useEffect(() => {
    api
      .get(`/api/projects/${projectId}/assignable-users`)
      .then(setAssignableUsers)
      .catch(() => setAssignableUsers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  usePollWhileVisible(loadData, 10_000);

  useEffect(() => subscribeBoardRefresh(projectId, loadData), [projectId, loadData]);

  async function handleBulkMove(status: string) {
    const ids = Array.from(selectedTasks);
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
      const names = held.map((n) => `${project?.key}-${n}`).join(", ");
      toast(`Moved ${movedIds.size} of ${ids.length}. ${names} being executed by a worker.`, "error");
    } else {
      toast(`Moved ${movedIds.size} of ${ids.length}`, "error");
    }
  }

  async function handleBulkSprint(sprintId: string | null) {
    const ids = Array.from(selectedTasks);
    const outcomes = await Promise.allSettled(
      ids.map((id) => api.put(`/api/projects/${projectId}/tasks/${id}`, { sprint: sprintId }))
    );

    const movedIds = ids.filter((_, i) => outcomes[i].status === "fulfilled");
    applySprintChange(movedIds, sprintId);
    setSelectedTasks(new Set());

    const target = sprintId
      ? sprints.find((s) => s._id === sprintId)?.name ?? "sprint"
      : "backlog";

    if (movedIds.length === ids.length) {
      toast(`Moved ${ids.length} task${ids.length === 1 ? "" : "s"} to ${target}`, "success");
    } else {
      toast(`Moved ${movedIds.length} of ${ids.length} to ${target}`, "error");
    }
  }

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
    const ids = Array.from(selectedTasks);
    setBulkDeleting(true);
    const outcomes = await Promise.allSettled(ids.map((id) => api.del(`/api/projects/${projectId}/tasks/${id}`)));
    setBulkDeleting(false);

    const deleted = new Set(ids.filter((_, i) => outcomes[i].status === "fulfilled"));
    const held = outcomes
      .map((outcome, i) => ({ outcome, id: ids[i] }))
      .filter(({ outcome }) => {
        if (outcome.status !== "rejected") return false;
        const failure = outcome.reason as { status?: number; body?: { runConflict?: unknown } };
        return failure?.status === 409 && !!failure.body?.runConflict;
      })
      .map(({ id }) => tasks.find((t) => t._id === id)?.taskNumber)
      .filter(Boolean);

    setTasks((prev) => prev.filter((t) => !deleted.has(t._id)));
    setSelectedTasks(new Set());
    setConfirmBulkDelete(false);

    if (deleted.size === ids.length) {
      toast(`Deleted ${ids.length} task${ids.length === 1 ? "" : "s"}`, "success");
    } else if (held.length > 0) {
      const names = held.map((n) => `${project?.key}-${n}`).join(", ");
      toast(`Deleted ${deleted.size} of ${ids.length}. ${names} being executed by a worker.`, "error");
    } else {
      toast(`Deleted ${deleted.size} of ${ids.length}`, "error");
    }
  }

  async function handleAssigneeChange(taskId: string, username: string) {
    try {
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
      ...(moved?.status === status ? {} : { status }),
    };

    try {
      await api.put(`/api/projects/${projectId}/tasks/${taskId}`, body);
    } catch (err) {
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

  async function handleReorder(orderedIds: string[]) {
    const rank = new Map(orderedIds.map((id, index) => [id, index]));
    setTasks((prev) =>
      prev.map((t) => (rank.has(t._id) ? { ...t, order: rank.get(t._id)! } : t))
    );

    try {
      await api.put(`/api/projects/${projectId}/tasks/reorder`, { order: orderedIds });
    } catch {
      toast("Failed to reorder tasks", "error");
      loadData();
    }
  }

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
    applySprintChange([taskId], sprintId);
    try {
      await api.put(`/api/projects/${projectId}/tasks/${taskId}`, { sprint: sprintId });
    } catch {
      toast("Failed to update sprint", "error");
      loadData();
    }
  }

  async function handleContextDuplicate(taskId: string) {
    const task = tasks.find((t) => t._id === taskId);
    if (!task) return;
    try {
      await api.post(`/api/projects/${projectId}/tasks`, duplicatePayload(task));
      toast("Task duplicated", "success");
      loadData();
    } catch {
      toast("Failed to duplicate task", "error");
    }
  }

  async function handleContextDelete(taskId: string, force?: boolean) {
    const remove = (asForce?: boolean) =>
      api.del(
        `/api/projects/${projectId}/tasks/${taskId}`,
        asForce ? { force: true } : undefined
      );
    setDeleting(true);
    try {
      await remove(force);
      setTasks((prev) => prev.filter((t) => t._id !== taskId));
      toast("Task deleted", "success");
    } catch (err) {
      const failure = err as { status?: number; body?: { runConflict?: RunConflict } };
      if (failure?.status === 409 && failure.body?.runConflict) {
        const task = tasks.find((t) => t._id === taskId);
        setConfirmContextDelete(null);
        setHeldDelete({
          retry: () => remove(true),
          conflict: failure.body.runConflict,
          taskKey: `${project?.key}-${task?.taskNumber}`,
        });
        return;
      }
      toast("Failed to delete task", "error");
    } finally {
      setDeleting(false);
      setConfirmContextDelete(null);
    }
  }

  async function forceHeldDelete() {
    if (!heldDelete) return;
    const pending = heldDelete;
    setHeldDelete(null);
    try {
      await pending.retry();
      toast("Task deleted", "success");
    } catch {
      toast("Failed to delete task", "error");
    }
    loadData();
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
    deleting,
    heldMove,
    heldDelete,
    setHeldDelete,
    forceHeldDelete,
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
