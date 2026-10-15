import { EXTERNAL_ID_MAX_LENGTH, EXTERNAL_SOURCE_MAX_LENGTH } from "./external-ref";

export const MAX_IMPORT_TASKS = 5_000;
export const MAX_IMPORT_COMMENTS = 50_000;
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export interface ImportComment {
  id: string;
  author?: string;
  body: string;
  createdAt?: string;
}

export interface ImportTask {
  id: string;
  title: string;
  description?: string;
  status?: string;
  type?: string;
  priority?: string;
  assignee?: string;
  createdAt?: string;
  completedAt?: string;
  fields?: Record<string, unknown>;
  comments?: ImportComment[];
  parent?: string;
  blockedBy?: string[];
}

export interface ImportBundle {
  source: string;
  tasks: ImportTask[];
}

export interface ImportMapping {
  statuses?: Record<string, string>;
  users?: Record<string, string | null>;
  types?: Record<string, string>;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optionalString = (v: unknown) => v === undefined || v === null || typeof v === "string";

function stringMap(v: unknown, name: string): Parsed<Record<string, string | null> | undefined> {
  if (v === undefined) return { ok: true, value: undefined };
  if (!isRecord(v)) return { ok: false, error: `mapping.${name} must be an object` };
  for (const [k, val] of Object.entries(v)) {
    if (val !== null && typeof val !== "string") return { ok: false, error: `mapping.${name}["${k.slice(0, 50)}"] must be a string` };
  }
  return { ok: true, value: v as Record<string, string | null> };
}

export function parseMapping(raw: unknown): Parsed<ImportMapping> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (!isRecord(raw)) return { ok: false, error: "mapping must be an object" };
  const statuses = stringMap(raw.statuses, "statuses");
  if (!statuses.ok) return statuses;
  const users = stringMap(raw.users, "users");
  if (!users.ok) return users;
  const types = stringMap(raw.types, "types");
  if (!types.ok) return types;
  return {
    ok: true,
    value: {
      statuses: statuses.value as Record<string, string> | undefined,
      users: users.value,
      types: types.value as Record<string, string> | undefined,
    },
  };
}

// The shape is checked whole before anything is written, so a malformed file is refused rather than half imported
export function parseBundle(raw: unknown): Parsed<ImportBundle> {
  if (!isRecord(raw)) return { ok: false, error: "The bundle must be an object" };
  const source = raw.source;
  if (typeof source !== "string" || !source.trim() || source.length > EXTERNAL_SOURCE_MAX_LENGTH) {
    return { ok: false, error: `source must be a name of 1 to ${EXTERNAL_SOURCE_MAX_LENGTH} characters` };
  }
  if (!Array.isArray(raw.tasks)) return { ok: false, error: "tasks must be a list" };
  if (raw.tasks.length > MAX_IMPORT_TASKS) {
    return { ok: false, error: `A bundle holds at most ${MAX_IMPORT_TASKS.toLocaleString("en-US")} tasks` };
  }

  const seen = new Set<string>();
  let comments = 0;
  for (const [index, task] of raw.tasks.entries()) {
    const at = `tasks[${index}]`;
    if (!isRecord(task)) return { ok: false, error: `${at} must be an object` };
    if (typeof task.id !== "string" || !task.id || task.id.length > EXTERNAL_ID_MAX_LENGTH) {
      return { ok: false, error: `${at}.id must be a string of 1 to ${EXTERNAL_ID_MAX_LENGTH} characters` };
    }
    if (seen.has(task.id)) return { ok: false, error: `${at}.id "${task.id.slice(0, 50)}" appears twice` };
    seen.add(task.id);
    if (typeof task.title !== "string") return { ok: false, error: `${at}.title must be a string` };
    for (const key of ["description", "status", "type", "priority", "assignee", "createdAt", "completedAt", "parent"]) {
      if (!optionalString(task[key])) return { ok: false, error: `${at}.${key} must be a string` };
    }
    if (task.fields !== undefined && !isRecord(task.fields)) return { ok: false, error: `${at}.fields must be an object` };
    if (task.blockedBy !== undefined && (!Array.isArray(task.blockedBy) || task.blockedBy.some((b) => typeof b !== "string"))) {
      return { ok: false, error: `${at}.blockedBy must be a list of ids` };
    }
    if (task.comments !== undefined) {
      if (!Array.isArray(task.comments)) return { ok: false, error: `${at}.comments must be a list` };
      const commentIds = new Set<string>();
      for (const [ci, comment] of task.comments.entries()) {
        const cat = `${at}.comments[${ci}]`;
        if (!isRecord(comment)) return { ok: false, error: `${cat} must be an object` };
        if (typeof comment.id !== "string" || !comment.id || comment.id.length > EXTERNAL_ID_MAX_LENGTH) {
          return { ok: false, error: `${cat}.id must be a string of 1 to ${EXTERNAL_ID_MAX_LENGTH} characters` };
        }
        if (commentIds.has(comment.id)) return { ok: false, error: `${cat}.id appears twice on its task` };
        commentIds.add(comment.id);
        if (typeof comment.body !== "string") return { ok: false, error: `${cat}.body must be a string` };
        if (!optionalString(comment.author) || !optionalString(comment.createdAt)) {
          return { ok: false, error: `${cat}.author and createdAt must be strings` };
        }
      }
      comments += task.comments.length;
    }
  }
  if (comments > MAX_IMPORT_COMMENTS) {
    return { ok: false, error: `A bundle holds at most ${MAX_IMPORT_COMMENTS.toLocaleString("en-US")} comments` };
  }
  return { ok: true, value: { source: source.trim(), tasks: raw.tasks as ImportTask[] } };
}
