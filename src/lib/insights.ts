import type { TaskStatusHistory } from "@/lib/status-history";

export const WEEK_MS = 7 * 86_400_000;
export const DEFAULT_WEEKS = 12;
export const MAX_WEEKS = 52;
export const FINISHED_SAMPLE_CAP = 5000;

export interface Spread {
  count: number;
  medianMs: number;
  p85Ms: number;
}

export interface FlowFigures {
  throughput: number;
  leadTime: Spread | null;
  cycleTime: Spread | null;
}

export interface AgingTask {
  taskNumber: number;
  title: string;
  status: string;
  startedAt: string;
  ageMs: number;
  olderThanPercent: number | null;
}

export interface Insights {
  window: { weeks: number; from: string; to: string };
  empty: boolean;
  sample: { finished: number; cap: number; truncated: boolean };
  excluded: { noHistory: number; gap: number; startInferred: number };
  summary: FlowFigures;
  weekly: (FlowFigures & { weekStart: string })[];
  agingWip: { referenceP85Ms: number | null; tasks: AgingTask[] };
  byCategory: Record<string, FlowFigures>;
  byEstimate?: { field: { id: string; name: string }; values: Record<string, FlowFigures> };
}

interface Finished {
  finishedAt: number;
  leadMs: number;
  cycleMs: number | null;
  category: string;
  estimate: number | null;
}

/** Linear interpolation between closest ranks, as numpy's default and Excel's PERCENTILE.INC. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

function countBelow(sorted: number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function spread(values: number[]): Spread | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    medianMs: Math.round(percentile(sorted, 50)),
    p85Ms: Math.round(percentile(sorted, 85)),
  };
}

function figures(finished: Finished[]): FlowFigures {
  return {
    throughput: finished.length,
    leadTime: spread(finished.map((f) => f.leadMs)),
    cycleTime: spread(finished.flatMap((f) => (f.cycleMs === null ? [] : [f.cycleMs]))),
  };
}

function groupBy(finished: Finished[], keyOf: (f: Finished) => string): Record<string, FlowFigures> {
  const groups = new Map<string, Finished[]>();
  for (const f of finished) {
    const key = keyOf(f);
    const held = groups.get(key);
    if (held) held.push(f);
    else groups.set(key, [f]);
  }
  return Object.fromEntries([...groups].map(([key, members]) => [key, figures(members)]));
}

/**
 * Figures over the tasks finished in the last `weeks` weeks, by when they finished rather than
 * `updatedAt`. A task with a gap in its history has no trustworthy times and is left out of every
 * figure; an inferred start is left out of cycle time and aging WIP and kept in lead time, which does
 * not use it. `excluded` counts the tasks a figure would otherwise have used: for an inferred start,
 * those finished in the window or in progress; for no history or a gap, whose times are unknown, any
 * task in a done column or in progress.
 * An archived task that finished still counts as finished; it is never work in progress.
 */
export function computeInsights(
  tasks: TaskStatusHistory[],
  {
    now,
    weeks,
    estimateField,
  }: { now: number; weeks: number; estimateField?: { id: string; name: string } }
): Insights {
  const from = now - weeks * WEEK_MS;
  const excluded = { noHistory: 0, gap: 0, startInferred: 0 };
  const finishedAll: Finished[] = [];
  const inProgress: { task: TaskStatusHistory; startedAt: number }[] = [];

  for (const task of tasks) {
    const { history } = task;
    const couldCount = task.role === "done" || (task.role === "active" && !task.archived);
    if (history.kind === "no-history") {
      if (couldCount) excluded.noHistory++;
      continue;
    }
    if (history.gap) {
      if (couldCount) excluded.gap++;
      continue;
    }

    if (history.finishedAt && task.role === "done") {
      const finishedAt = history.finishedAt.getTime();
      if (finishedAt < from || finishedAt > now) continue;
      if (history.startInferred) excluded.startInferred++;
      const startedAt = history.startInferred ? null : history.startedAt;
      finishedAll.push({
        finishedAt,
        leadMs: Math.max(0, finishedAt - task.createdAt.getTime()),
        cycleMs: startedAt ? finishedAt - startedAt.getTime() : null,
        category: task.category,
        estimate: task.estimate,
      });
    } else if (task.role === "active" && !task.archived) {
      if (history.startInferred) excluded.startInferred++;
      else if (history.startedAt) inProgress.push({ task, startedAt: history.startedAt.getTime() });
    }
  }

  finishedAll.sort((a, b) => b.finishedAt - a.finishedAt);
  const truncated = finishedAll.length > FINISHED_SAMPLE_CAP;
  const finished = truncated ? finishedAll.slice(0, FINISHED_SAMPLE_CAP) : finishedAll;

  const byWeek: Finished[][] = Array.from({ length: weeks }, () => []);
  for (const f of finished) byWeek[Math.min(weeks - 1, Math.floor((f.finishedAt - from) / WEEK_MS))].push(f);
  const weekly = byWeek.map((inWeek, i) => ({
    weekStart: new Date(from + i * WEEK_MS).toISOString(),
    ...figures(inWeek),
  }));

  const cycles = finished.flatMap((f) => (f.cycleMs === null ? [] : [f.cycleMs])).sort((a, b) => a - b);
  const referenceP85Ms = cycles.length ? Math.round(percentile(cycles, 85)) : null;
  const agingTasks: AgingTask[] = inProgress
    .map(({ task, startedAt }) => {
      const ageMs = Math.max(0, now - startedAt);
      return {
        taskNumber: task.taskNumber,
        title: task.title,
        status: task.status,
        startedAt: new Date(startedAt).toISOString(),
        ageMs,
        olderThanPercent: cycles.length
          ? Math.round((countBelow(cycles, ageMs) / cycles.length) * 100)
          : null,
      };
    })
    .sort((a, b) => b.ageMs - a.ageMs);

  return {
    window: { weeks, from: new Date(from).toISOString(), to: new Date(now).toISOString() },
    empty: finished.length === 0,
    sample: { finished: finished.length, cap: FINISHED_SAMPLE_CAP, truncated },
    excluded,
    summary: figures(finished),
    weekly,
    agingWip: { referenceP85Ms, tasks: agingTasks },
    byCategory: groupBy(finished, (f) => f.category),
    ...(estimateField
      ? {
          byEstimate: {
            field: estimateField,
            values: groupBy(finished, (f) => (f.estimate === null ? "none" : String(f.estimate))),
          },
        }
      : {}),
  };
}

export function weeksOrRefusal(raw: string | null): { weeks: number } | { error: string } {
  if (raw === null || raw === "") return { weeks: DEFAULT_WEEKS };
  const weeks = Number(raw);
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_WEEKS) {
    return { error: `weeks must be a whole number from 1 to ${MAX_WEEKS}` };
  }
  return { weeks };
}

export function weeksSince(start: Date, now: number): number {
  return Math.min(MAX_WEEKS, Math.max(1, Math.ceil((now - start.getTime()) / WEEK_MS)));
}
