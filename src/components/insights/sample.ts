import { WEEK_MS, type Insights } from "@/lib/insights";

const DAY = 86_400_000;
const WEEKS = 12;
const TITLES = [
  "Export invoices as CSV",
  "Fix the login redirect loop",
  "Dark theme for the settings page",
  "Rate-limit the public API",
  "Retry failed webhook deliveries",
  "Keyboard shortcuts for the board",
];

function spread(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => {
    const rank = (p / 100) * (sorted.length - 1);
    const low = Math.floor(rank);
    return sorted[low] + (sorted[Math.ceil(rank)] - sorted[low]) * (rank - low);
  };
  return { count: sorted.length, medianMs: Math.round(at(50)), p85Ms: Math.round(at(85)) };
}

/** What the page would show for a healthy small team, for an organisation without the key. */
export function sampleInsights(now: number): Insights {
  const from = now - WEEKS * WEEK_MS;
  const points = Array.from({ length: 46 }, (_, i) => {
    const finishedAt = from + ((i * 7919) % (WEEKS * 7)) * DAY + DAY / 2;
    const cycleMs = (0.6 + ((i * 37) % 23) / 3) * DAY;
    return {
      taskNumber: 100 + i,
      title: TITLES[i % TITLES.length],
      finishedAt: new Date(finishedAt).toISOString(),
      cycleMs,
      leadMs: cycleMs + (1 + ((i * 13) % 9)) * DAY,
    };
  }).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));

  const weekly = Array.from({ length: WEEKS }, (_, i) => {
    const start = from + i * WEEK_MS;
    const inWeek = points.filter((p) => {
      const t = Date.parse(p.finishedAt);
      return t >= start && t < start + WEEK_MS;
    });
    return {
      weekStart: new Date(start).toISOString(),
      throughput: inWeek.length,
      leadTime: inWeek.length ? spread(inWeek.map((p) => p.leadMs)) : null,
      cycleTime: inWeek.length ? spread(inWeek.map((p) => p.cycleMs)) : null,
    };
  });
  const cycle = spread(points.map((p) => p.cycleMs));
  const shareOlderThan = (ageMs: number) =>
    Math.round((points.filter((p) => p.cycleMs < ageMs).length / points.length) * 100);

  return {
    window: { weeks: WEEKS, from: new Date(from).toISOString(), to: new Date(now).toISOString() },
    empty: false,
    sample: { finished: points.length, cap: 5000, truncated: false },
    excluded: { noHistory: 0, gap: 0, startInferred: 0 },
    summary: {
      throughput: points.length,
      leadTime: spread(points.map((p) => p.leadMs)),
      cycleTime: cycle,
    },
    weekly,
    agingWip: {
      referenceP85Ms: cycle.p85Ms,
      tasks: [
        { taskNumber: 151, title: "Migrate the search index", status: "in_progress", ageDays: 7.5 },
        { taskNumber: 154, title: "Audit-log export", status: "in_progress", ageDays: 4.5 },
        { taskNumber: 157, title: "Onboarding checklist", status: "in_progress", ageDays: 1.2 },
      ].map(({ ageDays, ...task }) => ({
        ...task,
        startedAt: new Date(now - ageDays * DAY).toISOString(),
        ageMs: ageDays * DAY,
        olderThanPercent: shareOlderThan(ageDays * DAY),
      })),
    },
    finished: { points, truncated: false },
    byCategory: {},
  };
}
