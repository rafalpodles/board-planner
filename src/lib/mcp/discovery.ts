import { taskKeyOf } from "@/lib/task-key";

const SHOWN = 300;
const clip = (value: string) => (value.length > SHOWN ? `${value.slice(0, SHOWN)}…` : value);
const named = (person: unknown) =>
  person && typeof person === "object" ? ((person as { username?: string }).username ?? null) : null;

type Found = {
  taskNumber: number;
  title?: string;
  status?: string;
  priority?: string;
  assignee?: unknown;
  project?: { key?: string; name?: string } | null;
};

/** What a search finds, one line each, with the key to act on it by and the board it is on. */
export const searchLines = (tasks: Found[]) =>
  tasks.map((task) => ({
    key: taskKeyOf(task.project?.key, task.taskNumber),
    title: task.title,
    status: task.status,
    priority: task.priority ?? "medium",
    assignee: named(task.assignee),
    project: task.project?.name ?? null,
  }));

type Stats = Record<string, unknown>;

/**
 * The numbers the stats page opens with: how much there is and how much is finished, where it sits, who
 * holds it, and the weekly rhythm. The per-field usage table is the page's own and is left out.
 */
export function statsSummary(stats: Stats) {
  const { total, done, statusBreakdown, categoryBreakdown, assigneeBreakdown, difficultyBreakdown, velocity, createdOverTime } = stats;
  return { total, done, statusBreakdown, categoryBreakdown, assigneeBreakdown, difficultyBreakdown, velocity, createdOverTime };
}

type Run = {
  taskKey: string;
  agentName?: string;
  outcome: string;
  refusedBy?: string;
  detail?: string;
  minutes?: number;
  costUsd?: number;
  finishedAt?: string;
};

/** A worker's runs on a board, newest first: which task, which agent, how it ended, and what it cost. */
export const runLines = (runs: Run[]) =>
  runs.map((run) => ({
    taskKey: run.taskKey,
    agent: run.agentName ?? "",
    outcome: run.outcome,
    refusedBy: run.refusedBy || null,
    detail: clip(run.detail ?? ""),
    minutes: run.minutes ?? 0,
    costUsd: run.costUsd ?? 0,
    finishedAt: run.finishedAt ?? null,
  }));

type Notice = {
  _id: string;
  type?: string;
  title?: string;
  body?: string;
  read?: boolean;
  createdAt?: string;
  actor?: unknown;
  task?: { taskNumber?: number } | null;
  project?: { key?: string; name?: string } | null;
};

/**
 * The bell as lines. `nextBefore` is the cursor for the page after this one — the time of the oldest
 * row shown — and is null when this page was not full, which is when nothing older is left.
 */
export function noticeLines(notices: Notice[], limit: number) {
  const lines = notices.map((notice) => ({
    id: String(notice._id),
    type: notice.type ?? null,
    title: notice.title ?? "",
    body: clip(notice.body ?? ""),
    read: !!notice.read,
    by: named(notice.actor),
    task: typeof notice.task?.taskNumber === "number" ? taskKeyOf(notice.project?.key, notice.task.taskNumber) : null,
    project: notice.project?.name ?? null,
    at: notice.createdAt ?? null,
  }));
  const last = lines.at(-1);
  return { returned: lines.length, unread: lines.filter((l) => !l.read).length, nextBefore: lines.length >= limit ? (last?.at ?? null) : null, notifications: lines };
}
