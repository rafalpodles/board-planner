// Copyright (c) 2026 Rafał Podleś. Licensed under the Board Planner Enterprise Edition Licence, see src/ee/LICENSE.
import type { Types } from "mongoose";
import type { ScopedDb } from "@/lib/db-scope";
import { getProjectColumns } from "@/lib/columns";
import { taskKeyOf } from "@/lib/task-key";
import { NOT_ARCHIVED } from "@/lib/task-archive";
import { buildBoardDigest } from "@/lib/pm/board-review";
import { projectStatusHistories, statusChangeFilter } from "@/lib/status-history";
import { gatewayWrite, type WriteResult } from "@/lib/ai-gateway";
import { resolveAiModel } from "@/lib/pm/availability";

export const SUMMARY_KINDS = ["standup", "sprint", "project"] as const;
export type SummaryKind = (typeof SUMMARY_KINDS)[number];

const DAY_MS = 86_400_000;
const LISTED = 15;
// A task this long in one column of an unfinished sprint is at risk
const AT_RISK_DAYS = 3;

interface TaskLine {
  key: string;
  title: string;
}

export interface Facts {
  kind: SummaryKind;
  title: string;
  // Every figure, as the server counted it; the model gets these and may repeat only these
  figures: { label: string; value: number }[];
  lists: { label: string; items: (TaskLine & { note?: string })[] }[];
}

/** The last day's moves between columns, by person, and what is blocked */
async function standupFacts(db: ScopedDb, projectId: string, now: Date): Promise<Facts | null> {
  const project = await db.Project.findById(projectId, "key columns").lean();
  if (!project) return null;
  const columns = getProjectColumns(project);
  const label = (id: string) => columns.find((c) => c.id === id)?.label ?? id;
  const blockedColumns = columns.filter((c) => c.role === "blocked").map((c) => c.id);
  const done = columns.filter((c) => c.role === "done").map((c) => c.id);

  const moves = await db.ActivityLog.find({ ...statusChangeFilter(projectId), createdAt: { $gte: new Date(now.getTime() - DAY_MS) } }, "task user oldValue newValue")
    .sort({ createdAt: 1 })
    .lean<{ task: Types.ObjectId; user: Types.ObjectId | null; oldValue: string; newValue: string }[]>();
  const [tasks, people, blocked] = await Promise.all([
    db.Task.find({ project: projectId, _id: { $in: moves.map((m) => m.task) }, ...NOT_ARCHIVED }, "taskNumber title").lean<{ _id: Types.ObjectId; taskNumber: number; title: string }[]>(),
    db.User.find({ _id: { $in: moves.map((m) => m.user).filter(Boolean) } }, "username fullName").lean<{ _id: Types.ObjectId; username: string; fullName?: string }[]>(),
    db.Task.find(
      { project: projectId, ...NOT_ARCHIVED, status: { $nin: done }, $or: [{ status: { $in: blockedColumns } }, { "blockedBy.0": { $exists: true } }] },
      "taskNumber title"
    ).lean<{ taskNumber: number; title: string }[]>(),
  ]);
  const taskOf = new Map(tasks.map((t) => [String(t._id), t]));
  const nameOf = new Map(people.map((p) => [String(p._id), p.fullName || p.username]));

  const byPerson = new Map<string, (TaskLine & { note: string })[]>();
  for (const move of moves) {
    const task = taskOf.get(String(move.task));
    if (!task) continue;
    const who = move.user ? (nameOf.get(String(move.user)) ?? "Someone") : "The board";
    const items = byPerson.get(who) ?? [];
    items.push({ key: taskKeyOf(project.key, task.taskNumber), title: task.title, note: `${label(move.oldValue)} → ${label(move.newValue)}` });
    byPerson.set(who, items);
  }
  const counted = [...byPerson.values()].reduce((n, items) => n + items.length, 0);
  const movers = new Set(moves.filter((mv) => mv.user && taskOf.has(String(mv.task))).map((mv) => String(mv.user))).size;

  return {
    kind: "standup",
    title: "Standup",
    figures: [
      { label: "Moves between columns in the last day", value: counted },
      { label: "People who moved work", value: movers },
      { label: "Blocked tasks", value: blocked.length },
    ],
    lists: [
      ...[...byPerson].map(([who, items]) => ({ label: `Moved by ${who}`, items: items.slice(0, LISTED) })),
      { label: "Blocked", items: blocked.slice(0, LISTED).map((t) => ({ key: taskKeyOf(project.key, t.taskNumber), title: t.title })) },
    ],
  };
}

/** A sprint's scope against what is done, and what has sat in one column too long */
async function sprintFacts(db: ScopedDb, projectId: string, sprintId: string, now: Date): Promise<Facts | null> {
  const [project, sprint] = await Promise.all([
    db.Project.findById(projectId, "key columns").lean(),
    db.Sprint.findOne({ _id: sprintId, project: projectId }, "name endDate").lean<{ name: string; endDate: Date }>(),
  ]);
  if (!project || !sprint) return null;
  const columns = getProjectColumns(project);
  const roleOf = new Map(columns.map((c) => [c.id, c.role]));
  const label = (id: string) => columns.find((c) => c.id === id)?.label ?? id;

  const tasks = await db.Task.find({ project: projectId, sprint: sprintId, ...NOT_ARCHIVED }, "taskNumber title status createdAt").lean<
    { _id: Types.ObjectId; taskNumber: number; title: string; status: string; createdAt: Date }[]
  >();
  const open = tasks.filter((t) => roleOf.get(t.status) !== "done");
  const lastMove = new Map<string, Date>();
  for (const row of await db.ActivityLog.find({ ...statusChangeFilter(projectId), task: { $in: open.map((t) => t._id) } }, "task createdAt")
    .sort({ createdAt: 1 })
    .lean<{ task: Types.ObjectId; createdAt: Date }[]>()) {
    lastMove.set(String(row.task), row.createdAt);
  }
  const atRisk = open
    .map((t) => ({ t, days: Math.floor((now.getTime() - (lastMove.get(String(t._id)) ?? t.createdAt).getTime()) / DAY_MS) }))
    .filter(({ days }) => days >= AT_RISK_DAYS)
    .sort((a, b) => b.days - a.days);

  return {
    kind: "sprint",
    title: `Sprint status: ${sprint.name}`,
    figures: [
      { label: "Tasks in the sprint", value: tasks.length },
      { label: "Done", value: tasks.length - open.length },
      { label: "Not done", value: open.length },
      { label: "Days left", value: Math.max(0, Math.ceil((new Date(sprint.endDate).getTime() - now.getTime()) / DAY_MS)) },
      { label: `Not done and ${AT_RISK_DAYS} or more days in one column`, value: atRisk.length },
    ],
    lists: [
      {
        label: "At risk",
        items: atRisk.slice(0, LISTED).map(({ t, days }) => ({ key: taskKeyOf(project.key, t.taskNumber), title: t.title, note: `${days} days in ${label(t.status)}` })),
      },
    ],
  };
}

/** The week: what came in, what finished, what is open, what is stuck */
async function projectFacts(db: ScopedDb, projectId: string, now: Date): Promise<Facts | null> {
  const digest = await buildBoardDigest(db, projectId);
  if (!digest) return null;
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const histories = (await projectStatusHistories(db, projectId)).filter((t) => !t.archived);
  const finished = histories.filter((t) => t.role === "done" && t.history.kind === "recorded" && t.history.finishedAt && t.history.finishedAt >= weekAgo);
  const created = histories.filter((t) => t.createdAt >= weekAgo);

  return {
    kind: "project",
    title: "Project status: the last seven days",
    figures: [
      { label: "Tasks created", value: created.length },
      { label: "Tasks finished", value: finished.length },
      { label: "Open tasks", value: digest.openTotal },
      ...digest.byStatus.map((s) => ({ label: `Open in ${s.label}`, value: s.count })),
      { label: "Stuck in a column", value: digest.stale.length },
    ],
    lists: [
      { label: "Finished", items: finished.slice(0, LISTED).map((t) => ({ key: taskKeyOf(digest.projectKey, t.taskNumber), title: t.title })) },
      { label: "Stuck", items: digest.stale.map((s) => ({ key: s.key, title: s.title, note: `${s.days} days in ${s.status}` })) },
    ],
  };
}

export async function summaryFacts(db: ScopedDb, projectId: string, kind: SummaryKind, sprintId: string | null, now = new Date()): Promise<Facts | null> {
  if (kind === "standup") return standupFacts(db, projectId, now);
  if (kind === "sprint") return sprintId ? sprintFacts(db, projectId, sprintId, now) : null;
  return projectFacts(db, projectId, now);
}

/** The figures as the server counted them, in Markdown; the only place a number in a summary comes from */
export function renderFacts(facts: Facts): string {
  const lines = [`## ${facts.title}`, "", ...facts.figures.map((f) => `- ${f.label}: **${f.value}**`)];
  for (const list of facts.lists) {
    if (list.items.length === 0) continue;
    lines.push("", `**${list.label}**`, ...list.items.map((i) => `- ${i.key} ${i.title}${i.note ? ` (${i.note})` : ""}`));
  }
  return lines.join("\n");
}

export function summaryInstructions(kind: SummaryKind): string {
  const subject = { standup: "a team's last day", sprint: "how a sprint is going", project: "a project's last week" }[kind];
  return [
    `You write a short status note in Markdown about ${subject}, from the facts given.`,
    "Two to five sentences: what moved, what is at risk or blocked, and what needs a decision. Name tasks by their key.",
    "Write no figures at all: no counts, percentages, days or dates. The figures are shown beside your note, exactly as counted, so a number of yours could only contradict them.",
    "Answer with the note only, with no heading.",
  ].join(" ");
}

// A number in the note outside a task key; every one must be a figure the server counted
export function figuresOutsideFacts(note: string, facts: Facts): number[] {
  const allowed = new Set(facts.figures.map((f) => f.value));
  const withoutKeys = note.replace(/\b[A-Z][A-Z0-9]*-\d+\b/g, "");
  return [...withoutKeys.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(",", "."))).filter((n) => !allowed.has(n));
}

export type SummaryResult = { ok: true; markdown: string; noteDropped: boolean } | Extract<WriteResult, { ok: false }>;

export async function writeSummary(db: ScopedDb, context: { projectId: string; userId: string }, facts: Facts): Promise<SummaryResult> {
  const figures = renderFacts(facts);
  const written = await gatewayWrite(db, { ...context, source: "digest" }, { model: await resolveAiModel(db), instructions: summaryInstructions(facts.kind), data: facts });
  if (!written.ok) return written;
  // A note that counts for itself is not shown: the figures beside it are the server's, and only those
  if (figuresOutsideFacts(written.text, facts).length > 0 || !written.text.trim()) return { ok: true, markdown: figures, noteDropped: true };
  return { ok: true, markdown: `${written.text.trim()}\n\n${figures}`, noteDropped: false };
}
