import { Types } from "mongoose";
import { Project } from "@/models/project";
import { Task } from "@/models/task";
import { ActivityLog } from "@/models/activityLog";
import { ColumnRole } from "@/types";
import { getProjectColumns } from "@/lib/columns";

const STALE_DAYS_BY_ROLE: Partial<Record<ColumnRole, number>> = {
  approved: 7,
  active: 3,
  review: 3,
  blocked: 3,
};
const REFINABLE_ROLES: ColumnRole[] = ["approved", "active", "review", "blocked"];
const DUPLICATE_SIMILARITY = 0.6;
const MAX_TASKS_SCANNED = 500;
const MAX_ITEMS_PER_FINDING = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

// Short and shared between the two languages this board is written in
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "when", "what", "not", "add", "new",
  "oraz", "dla", "przez", "kiedy", "jest", "jako", "nie", "aby", "nowy", "nowa", "nowe",
]);

export interface BoardDigestTask {
  key: string;
  title: string;
  status: string;
}

export interface BoardGap extends BoardDigestTask {
  missing: string;
}

export interface BoardStale extends BoardDigestTask {
  days: number;
}

export interface BoardDuplicate {
  keys: [string, string];
  titles: [string, string];
}

export interface BoardDigest {
  projectKey: string;
  openTotal: number;
  byStatus: { status: string; label: string; count: number }[];
  gaps: BoardGap[];
  stale: BoardStale[];
  duplicates: BoardDuplicate[];
  truncated: boolean;
}

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(" ")
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

async function lastStatusChangeByTask(taskIds: Types.ObjectId[]): Promise<Map<string, Date>> {
  const logs = await ActivityLog.find(
    { task: { $in: taskIds }, action: "status_changed" },
    "task createdAt"
  )
    .sort({ createdAt: -1 })
    .lean();
  const latest = new Map<string, Date>();
  for (const log of logs) {
    const key = String(log.task);
    if (!latest.has(key)) latest.set(key, log.createdAt);
  }
  return latest;
}

export async function buildBoardDigest(projectId: string): Promise<BoardDigest | null> {
  const project = await Project.findById(projectId, "key columns").lean();
  if (!project) return null;

  const columns = getProjectColumns(project);
  const roleOf = new Map(columns.map((c) => [c.id, c.role]));
  const labelOf = new Map(columns.map((c) => [c.id, c.label]));
  const doneStatuses = columns.filter((c) => c.role === "done").map((c) => c.id);

  const filter = { project: project._id, status: { $nin: doneStatuses } };
  const [openTotal, tasks] = await Promise.all([
    Task.countDocuments(filter),
    Task.find(filter, "taskNumber title status description checklist createdAt")
      .sort({ taskNumber: -1 })
      .limit(MAX_TASKS_SCANNED)
      .lean(),
  ]);

  const counts = new Map<string, number>();
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) || 0) + 1);
  const byStatus = columns
    .filter((c) => counts.has(c.id))
    .map((c) => ({ status: c.id, label: c.label, count: counts.get(c.id)! }));

  const keyOf = (taskNumber: number) => `${project.key}-${taskNumber}`;
  const statusLabel = (status: string) => labelOf.get(status) || status;

  const gaps: BoardGap[] = [];
  for (const task of tasks) {
    const role = roleOf.get(task.status);
    if (!role || !REFINABLE_ROLES.includes(role)) continue;
    const missing: string[] = [];
    if (!(task.checklist || []).length) missing.push("acceptance criteria");
    if (!(task.description || "").trim()) missing.push("description");
    if (missing.length === 0) continue;
    gaps.push({
      key: keyOf(task.taskNumber),
      title: task.title,
      status: statusLabel(task.status),
      missing: missing.join(" and "),
    });
  }

  const lastChange = await lastStatusChangeByTask(tasks.map((t) => t._id));
  const now = Date.now();
  const stale: BoardStale[] = [];
  for (const task of tasks) {
    const role = roleOf.get(task.status);
    const threshold = role && STALE_DAYS_BY_ROLE[role];
    if (!threshold) continue;
    const since = lastChange.get(String(task._id)) ?? task.createdAt;
    const days = Math.floor((now - new Date(since).getTime()) / DAY_MS);
    if (days < threshold) continue;
    stale.push({
      key: keyOf(task.taskNumber),
      title: task.title,
      status: statusLabel(task.status),
      days,
    });
  }
  stale.sort((a, b) => b.days - a.days);

  const tokenized = tasks.map((t) => ({ task: t, tokens: titleTokens(t.title) }));
  const duplicates: BoardDuplicate[] = [];
  for (let i = 0; i < tokenized.length; i++) {
    for (let j = i + 1; j < tokenized.length; j++) {
      if (jaccard(tokenized[i].tokens, tokenized[j].tokens) < DUPLICATE_SIMILARITY) continue;
      duplicates.push({
        keys: [keyOf(tokenized[i].task.taskNumber), keyOf(tokenized[j].task.taskNumber)],
        titles: [tokenized[i].task.title, tokenized[j].task.title],
      });
    }
  }

  return {
    projectKey: project.key,
    openTotal,
    byStatus,
    gaps: gaps.slice(0, MAX_ITEMS_PER_FINDING),
    stale: stale.slice(0, MAX_ITEMS_PER_FINDING),
    duplicates: duplicates.slice(0, MAX_ITEMS_PER_FINDING),
    truncated: openTotal > tasks.length,
  };
}

// The thread (and every later turn's replayed history) keeps this line instead of the
// full scan, which would otherwise repeat in the context once per review
export function digestHeadline(digest: BoardDigest): string {
  const findings = [
    digest.gaps.length && `${digest.gaps.length} missing acceptance criteria or description`,
    digest.stale.length && `${digest.stale.length} stuck in a column`,
    digest.duplicates.length && `${digest.duplicates.length} possible duplicate`,
  ].filter(Boolean);
  return `Scheduled board review — ${digest.openTotal} open tasks; ${
    findings.length ? findings.join(", ") : "nothing flagged"
  }.`;
}

export function renderBoardDigest(digest: BoardDigest): string {
  const lines: string[] = [
    `Open tasks: ${digest.openTotal}${digest.truncated ? ` (scan covers the ${MAX_TASKS_SCANNED} newest)` : ""}`,
    `By column: ${digest.byStatus.map((s) => `${s.label} ${s.count}`).join(", ") || "empty board"}`,
  ];

  lines.push(``, `Missing acceptance criteria or description (${digest.gaps.length}):`);
  for (const gap of digest.gaps) {
    lines.push(`- ${gap.key} [${gap.status}] "${gap.title}" — no ${gap.missing}`);
  }
  if (digest.gaps.length === 0) lines.push(`- none`);

  lines.push(``, `Sitting in the same column for a long time (${digest.stale.length}):`);
  for (const item of digest.stale) {
    lines.push(`- ${item.key} [${item.status}] "${item.title}" — ${item.days} days`);
  }
  if (digest.stale.length === 0) lines.push(`- none`);

  lines.push(``, `Possible duplicates by title (${digest.duplicates.length}):`);
  for (const pair of digest.duplicates) {
    lines.push(`- ${pair.keys[0]} "${pair.titles[0]}" ~ ${pair.keys[1]} "${pair.titles[1]}"`);
  }
  if (digest.duplicates.length === 0) lines.push(`- none`);

  return lines.join("\n");
}
