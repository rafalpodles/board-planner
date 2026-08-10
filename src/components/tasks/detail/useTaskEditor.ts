"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { emitBoardRefresh } from "@/lib/board-refresh";
import {
  ApiTask,
  Category,
  Priority,
  RecurrenceFrequency,
} from "@/types";

const AUTOSAVE_DEBOUNCE_MS = 700;

export type AutoSaveState = "idle" | "saving" | "saved" | "error";

/** A criterion the user just typed has no id until the server assigns one */
export type ChecklistDraftItem = { _id?: string; text: string; done: boolean };

/**
 * Everything the detail view edits in place. `status` is absent because moving a task is its own
 * act with its own endpoint, not a field edit that autosaves under you.
 *
 * It used to be absent for a second reason — the status endpoint was the only path that ran the
 * transition side effects, so PUTting a status here would have silently skipped recurrence,
 * webhooks and notifications. BP-253 moved those behind one helper both paths call, so that is
 * no longer true and this omission is no longer load-bearing.
 */
export interface TaskDraft {
  title: string;
  description: string;
  priority: Priority;
  category: Category;
  assignee: string | null;
  dueDate: string | null;
  checklist: ChecklistDraftItem[];
  sprint: string | null;
  recurrence: { frequency: RecurrenceFrequency; interval: number } | null;
  customFieldValues: Record<string, unknown>;
}

/** Seeds the draft and doubles as the server snapshot, so the two can never disagree */
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
    sprint: task.sprint || null,
    recurrence: task.recurrence
      ? { frequency: task.recurrence.frequency, interval: task.recurrence.interval }
      : null,
    customFieldValues: task.customFieldValues || {},
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function useTaskEditor(projectId: string, task: ApiTask) {
  const api = useApi();
  const [draft, setDraft] = useState<TaskDraft>(() => draftFromTask(task));
  const [autoSaveState, setAutoSaveState] = useState<AutoSaveState>("idle");

  // What the server last told us each field holds. A field counts as edited only when it
  // differs from this, and auto-save sends edited fields alone — so a concurrent change to
  // a field this view never touched (a PM status move, say) is not written back over.
  const serverValues = useRef<TaskDraft>(draftFromTask(task));
  const localValues = useRef(draft);
  localValues.current = draft;

  // The task was reloaded: adopt whatever changed underneath us, but only for fields the
  // user has not edited — their in-progress edits win and stay pending.
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
        setAutoSaveState("saved");
        emitBoardRefresh(projectId);
      } catch {
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

  // Closing within the debounce window used to drop the edit on the floor: the
  // cleanup above also runs on unmount. Now the pending edit goes out on the way.
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

  const set = useCallback(<K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  }, []);

  const retry = useCallback(() => persist(editedFields()), [persist, editedFields]);

  return { draft, set, autoSaveState, retry };
}
