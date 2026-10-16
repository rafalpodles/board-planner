// Copyright (c) 2026 Rafał Podleś. Licensed under the Board Planner Enterprise Edition Licence, see src/ee/LICENSE.
import type { ScopedDb } from "@/lib/db-scope";
import { gatewayWrite, type WriteResult } from "@/lib/ai-gateway";
import { resolveAiModel } from "@/lib/pm/availability";
import { jaccard, titleTokens } from "@/lib/pm/board-review";
import { taskKeyOf } from "@/lib/task-key";
import { NOT_ARCHIVED } from "@/lib/task-archive";

export const TASKS_SCANNED = 500;
export const SHORTLIST_MAX = 8;
export const SHORTLIST_MIN_SCORE = 0.2;
export const DUPLICATES_MAX = 5;
const DESCRIPTION_READ = 600;
const REASON_MAX = 200;

export interface Draft {
  title: string;
  description: string;
}

export interface Candidate {
  taskId: string;
  taskNumber: number;
  key: string;
  title: string;
  status: string;
  description: string;
  score: number;
}

export interface Duplicate {
  taskId: string;
  taskNumber: number;
  key: string;
  title: string;
  status: string;
  reason: string;
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  // One shared word is a coincidence once there are two to share
  if (shared < Math.min(2, a.size)) return 0;
  return shared / Math.min(a.size, b.size);
}

interface DraftTokens {
  title: Set<string>;
  whole: Set<string>;
}

function draftTokens(draft: Draft): DraftTokens {
  return { title: titleTokens(draft.title), whole: titleTokens(`${draft.title} ${draft.description.slice(0, DESCRIPTION_READ)}`) };
}

function scoreAgainst(tokens: DraftTokens, other: { title: string; description: string }): number {
  const titles = jaccard(tokens.title, titleTokens(other.title));
  const whole = overlap(tokens.whole, titleTokens(`${other.title} ${other.description.slice(0, DESCRIPTION_READ)}`));
  return Math.max(titles, whole * 0.6);
}

export function lexicalScore(draft: Draft, other: { title: string; description: string }): number {
  return scoreAgainst(draftTokens(draft), other);
}

export async function shortlist(db: ScopedDb, projectId: string, draft: Draft, excludeTaskIds: string[] = []): Promise<Candidate[]> {
  const project = await db.Project.findById(projectId, "key").lean();
  if (!project) return [];
  const tokens = draftTokens(draft);
  const tasks = await db.Task.find(
    { project: projectId, ...NOT_ARCHIVED, ...(excludeTaskIds.length > 0 && { _id: { $nin: excludeTaskIds } }) },
    "taskNumber title description status"
  )
    .sort({ taskNumber: -1 })
    .limit(TASKS_SCANNED)
    .lean();
  return tasks
    .map((t) => ({
      taskId: String(t._id),
      taskNumber: t.taskNumber,
      key: taskKeyOf(project.key, t.taskNumber),
      title: t.title,
      status: String(t.status),
      description: (t.description ?? "").slice(0, DESCRIPTION_READ),
      score: scoreAgainst(tokens, { title: t.title, description: t.description ?? "" }),
    }))
    .filter((c) => c.score >= SHORTLIST_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, SHORTLIST_MAX);
}

export function duplicateInstructions(): string {
  return [
    "Decide which of `candidates` describe the same piece of work as `draft`, however differently worded. A task that is merely related, or covers a different part of the product, is not a duplicate.",
    `Answer with JSON alone, no prose and no code fence: {"duplicates":[{"key":"…","reason":"…"}]}, at most ${DUPLICATES_MAX}, the likeliest first, each reason under 20 words. An empty list is a fine answer.`,
    "Use only keys that appear in `candidates`.",
  ].join("\n");
}

export function duplicatesFrom(text: string, candidates: Candidate[]): Duplicate[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let answer: unknown;
  try {
    answer = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const listed = (answer as { duplicates?: unknown })?.duplicates;
  if (!Array.isArray(listed)) return [];
  const out: Duplicate[] = [];
  for (const item of listed) {
    const key = typeof item?.key === "string" ? item.key.trim().toUpperCase() : "";
    const candidate = candidates.find((c) => c.key === key);
    if (!candidate || out.some((d) => d.taskId === candidate.taskId)) continue;
    const reason = typeof item?.reason === "string" ? item.reason.trim().slice(0, REASON_MAX) : "";
    out.push({ taskId: candidate.taskId, taskNumber: candidate.taskNumber, key: candidate.key, title: candidate.title, status: candidate.status, reason });
    if (out.length === DUPLICATES_MAX) break;
  }
  return out;
}

export type DuplicatesResult = { ok: true; duplicates: Duplicate[]; shortlisted: number } | Extract<WriteResult, { ok: false }>;

export async function findDuplicates(
  db: ScopedDb,
  context: { projectId: string; userId: string },
  draft: Draft,
  excludeTaskIds: string[] = []
): Promise<DuplicatesResult> {
  const candidates = await shortlist(db, context.projectId, draft, excludeTaskIds);
  if (candidates.length === 0) return { ok: true, duplicates: [], shortlisted: 0 };
  const written = await gatewayWrite(
    db,
    { ...context, source: "duplicates" },
    {
      model: await resolveAiModel(db),
      instructions: duplicateInstructions(),
      data: { draft: { title: draft.title, description: draft.description.slice(0, DESCRIPTION_READ) }, candidates: candidates.map(({ key, title, description }) => ({ key, title, description })) },
    }
  );
  if (!written.ok) return written;
  return { ok: true, duplicates: duplicatesFrom(written.text, candidates), shortlisted: candidates.length };
}
