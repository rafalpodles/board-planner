"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { emitBoardRefresh } from "@/lib/board-refresh";
import { refIdOf } from "@/lib/handover";
import {
  ApiTask,
  Category,
  Priority,
  RecurrenceFrequency,
} from "@/types";

const AUTOSAVE_DEBOUNCE_MS = 700;

export type AutoSaveState = "idle" | "saving" | "saved" | "error";

export type ChecklistDraftItem = { _id?: string; text: string; done: boolean };

export interface TaskDraft {
  title: string;
  description: string;
  priority: Priority;
  category: Category;
  assignee: string | null;
  dueDate: string | null;
  checklist: ChecklistDraftItem[];
  sprint: string | null;
  agent: string | null;
  recurrence: { frequency: RecurrenceFrequency; interval: number; endDate: string | null } | null;
  customFieldValues: Record<string, unknown>;
}

export function draftFromTask(task: ApiTask): TaskDraft {
  return {
    title: task.title || "",
    description: task.description || "",
    priority: task.priority || "medium",
    category: task.category,
    assignee:
      (task.assignee && typeof task.assignee === "object" ? task.assignee.username : "") || null,
    dueDate: (task.dueDate ? task.dueDate.substring(0, 10) : "") || null,
    checklist: task.checklist || [],
    agent: refIdOf(task.agent),
    sprint: task.sprint || null,
    recurrence: task.recurrence
      ? {
          frequency: task.recurrence.frequency,
          interval: task.recurrence.interval,
          endDate: task.recurrence.endDate ? task.recurrence.endDate.substring(0, 10) : null,
        }
      : null,
    customFieldValues: task.customFieldValues || {},
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function useTaskEditor(projectId: string, task: ApiTask) {
  const api = useApi();
  const [draft, setDraft] = useState<TaskDraft>(() => draftFromTask(task));
  const [autoSaveState, setAutoSaveState] = useState<AutoSaveState>("idle");
  const [autoSaveError, setAutoSaveError] = useState<string | null>(null);

  const serverValues = useRef<TaskDraft>(draftFromTask(task));
  const localValues = useRef(draft);
  localValues.current = draft;

  useEffect(() => {
    const next = draftFromTask(task);
    const previous = serverValues.current;
    const adopted: Partial<TaskDraft> = {};
    for (const key of Object.keys(next) as (keyof TaskDraft)[]) {
      if (same(next[key], previous[key])) continue;
      if (same(localValues.current[key], previous[key])) {
        adopted[key] = next[key] as never;
      }
    }
    serverValues.current = next;
    if (Object.keys(adopted).length > 0) setDraft((d) => ({ ...d, ...adopted }));
  }, [task]);

  const editedFields = useCallback((): Partial<TaskDraft> => {
    const base = serverValues.current;
    const edited: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(draft)) {
      if (!same(value, base[key as keyof TaskDraft])) edited[key] = value;
    }
    return edited as Partial<TaskDraft>;
  }, [draft]);

  const signature = JSON.stringify(editedFields());

  const persist = useCallback(
    async (edited: Partial<TaskDraft>) => {
      if (Object.keys(edited).length === 0) return;
      setAutoSaveState("saving");
      try {
        await api.put(`/api/projects/${projectId}/tasks/${task._id}`, edited);
        serverValues.current = { ...serverValues.current, ...edited };
        setAutoSaveError(null);
        setAutoSaveState("saved");
        emitBoardRefresh(projectId);
      } catch (err) {
        setAutoSaveError(err instanceof Error && err.message ? err.message : null);
        setAutoSaveState("error");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, task._id]
  );

  useEffect(() => {
    if (signature === "{}") return;
    const timer = setTimeout(() => persist(JSON.parse(signature)), AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [signature, persist]);

  const pendingRef = useRef("{}");
  pendingRef.current = signature;
  useEffect(() => {
    const taskId = task._id;
    return () => {
      const pending = pendingRef.current;
      if (pending === "{}") return;
      api
        .put(`/api/projects/${projectId}/tasks/${taskId}`, JSON.parse(pending))
        .then(() => emitBoardRefresh(projectId))
        .catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task._id, projectId]);

  useEffect(() => {
    const taskId = task._id;
    const flush = () => {
      const pending = pendingRef.current;
      if (pending === "{}") return;
      fetch(`/api/projects/${projectId}/tasks/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: pending,
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [task._id, projectId]);

  const set = useCallback(<K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  }, []);

  const retry = useCallback(() => persist(editedFields()), [persist, editedFields]);

  const resend = useCallback(
    <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) =>
      persist({ [key]: value } as Partial<TaskDraft>),
    [persist]
  );

  return { draft, set, autoSaveState, autoSaveError, retry, resend };
}
