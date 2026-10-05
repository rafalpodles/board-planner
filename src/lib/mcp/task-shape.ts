import { taskKeyOf } from "@/lib/task-key";
import type { DependencyType } from "@/types";

type Linked = { _id?: unknown; taskNumber?: number; title?: string; status?: string };
type Relation = { type?: string; task?: Linked | null };

type TaskLike = {
  taskNumber?: number;
  title?: string;
  status?: string;
  priority?: string;
  assignee?: { username?: string } | null;
};

/** What a write answers with when the caller asked for `minimal`: enough to know it worked and to find it. */
export function taskSummary(task: TaskLike, taskKey: string, url: string) {
  return {
    key: taskKey,
    title: task.title,
    status: task.status,
    priority: task.priority,
    assignee: task.assignee?.username ?? null,
    url,
  };
}

const withKey = (projectKey: string, task: Linked | null | undefined) =>
  task && typeof task.taskNumber === "number"
    ? { ...task, key: taskKeyOf(projectKey, task.taskNumber) }
    : task;

const brief = (projectKey: string, task: Linked | null | undefined) =>
  task && typeof task.taskNumber === "number"
    ? { key: taskKeyOf(projectKey, task.taskNumber), title: task.title, status: task.status }
    : null;

/**
 * The task as the API stores it, plus the one thing the API leaves for the caller to rebuild: each
 * linked task's key. Additive — every field a client already reads is still there — and `parent`
 * and `children` are the parent_of link read from both ends, which is how an epic is told from a
 * task with a checklist.
 */
export function withTaskKeys<T extends Record<string, unknown>>(task: T, projectKey: string) {
  const keyed = (entries: unknown) =>
    Array.isArray(entries)
      ? entries.map((entry: Relation) => ({ ...entry, task: withKey(projectKey, entry?.task) }))
      : entries;
  const linked = (tasks: unknown) =>
    Array.isArray(tasks) ? tasks.map((t: Linked) => withKey(projectKey, t)) : tasks;

  const relations = Array.isArray(task.relations) ? (task.relations as Relation[]) : [];
  const relatedFrom = Array.isArray(task.relatedFrom) ? (task.relatedFrom as Relation[]) : [];
  const parentEnd = relatedFrom.find((r) => r.type === "parent_of");

  return {
    ...task,
    blockedBy: linked(task.blockedBy),
    blocking: linked(task.blocking),
    relations: keyed(task.relations),
    relatedFrom: keyed(task.relatedFrom),
    parent: brief(projectKey, parentEnd?.task),
    children: relations
      .filter((r) => r.type === "parent_of")
      .map((r) => brief(projectKey, r.task))
      .filter((child) => child !== null),
  };
}

const LINK_SENTENCES: Record<DependencyType, (a: string, b: string) => string> = {
  blocked_by: (a, b) => `${a} is blocked by ${b}`,
  relates: (a, b) => `${a} relates to ${b}`,
  duplicates: (a, b) => `${a} is a duplicate of ${b}`,
  parent_of: (a, b) => `${a} is the parent of ${b}`,
};

/** The answer to link_tasks and unlink_tasks: both keys, the type, and which way it reads. */
export function describeLink(type: DependencyType, taskKey: string, targetTaskKey: string, removed: boolean) {
  const a = taskKey.toUpperCase();
  const b = targetTaskKey.toUpperCase();
  const sentence = LINK_SENTENCES[type](a, b);
  return {
    message: removed ? `Removed: ${sentence}` : `Linked: ${sentence}`,
    taskKey: a,
    targetTaskKey: b,
    type,
  };
}
