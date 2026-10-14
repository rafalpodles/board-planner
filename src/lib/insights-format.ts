const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < HOUR_MS) return "under 1 h";
  if (ms < DAY_MS) return `${Math.round(ms / HOUR_MS)} h`;
  const days = ms / DAY_MS;
  return `${days < 10 ? days.toFixed(1).replace(/\.0$/, "") : Math.round(days)} d`;
}

export function formatWeek(iso: string): string {
  const date = new Date(iso);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (step * magnitude >= value) return step * magnitude;
  }
  return 10 * magnitude;
}
