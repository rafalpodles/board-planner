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
 * figure; an inferred start is left out of cycle time and kept in lead time, which does not use it.
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
    if (history.kind === "no-history") {
      excluded.noHistory++;
      continue;
    }
    if (history.gap) {
      excluded.gap++;
      continue;
    }
    if (history.startInferred) excluded.startInferred++;

    if (history.finishedAt && task.role === "done") {
      const finishedAt = history.finishedAt.getTime();
      if (finishedAt < from || finishedAt > now) continue;
      const startedAt = history.startInferred ? null : history.startedAt;
      finishedAll.push({
        finishedAt,
        leadMs: finishedAt - task.createdAt.getTime(),
        cycleMs: startedAt ? finishedAt - startedAt.getTime() : null,
        category: task.category,
        estimate: task.estimate,
      });
    } else if (task.role === "active" && !task.archived && history.startedAt && !history.startInferred) {
      inProgress.push({ task, startedAt: history.startedAt.getTime() });
    }
  }

  finishedAll.sort((a, b) => b.finishedAt - a.finishedAt);
  const truncated = finishedAll.length > FINISHED_SAMPLE_CAP;
  const finished = truncated ? finishedAll.slice(0, FINISHED_SAMPLE_CAP) : finishedAll;

  const weekly = Array.from({ length: weeks }, (_, i) => {
    const start = from + i * WEEK_MS;
    const end = start + WEEK_MS;
    const last = i === weeks - 1;
    const inWeek = finished.filter((f) => f.finishedAt >= start && (last ? f.finishedAt <= end : f.finishedAt < end));
    return { weekStart: new Date(start).toISOString(), ...figures(inWeek) };
  });

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
          ? Math.round((cycles.filter((c) => c < ageMs).length / cycles.length) * 100)
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
