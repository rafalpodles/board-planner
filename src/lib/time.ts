const MAX_CACHED_ZONES = 64;

function formatter(kind: "hour" | "day", timeZone: string): Intl.DateTimeFormat {
  const key = `${kind}\u0000${timeZone}`;
  const cached = formatters.get(key);
  if (cached) return cached;
  if (formatters.size >= MAX_CACHED_ZONES) formatters.clear();
  const made =
    kind === "hour"
      ? new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" })
      : new Intl.DateTimeFormat("en-CA", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        });
  formatters.set(key, made);
  return made;
}
const formatters = new Map<string, Intl.DateTimeFormat>();

export function hourInTimezone(date: Date, timeZone: string): number {
  return Number(formatter("hour", timeZone).format(date));
}

export function dayKeyInTimezone(date: Date, timeZone: string): string {
  return formatter("day", timeZone).format(date);
}

const A_DAY_AND_SOME = 26 * 60 * 60 * 1000;

export function startOfDayInTimezone(date: Date, timeZone: string): Date {
  const key = dayKeyInTimezone(date, timeZone);
  const isTheDay = (t: number) => dayKeyInTimezone(new Date(t), timeZone) === key;

  let before = date.getTime() - A_DAY_AND_SOME;
  for (let i = 0; i < 4 && isTheDay(before); i += 1) before -= A_DAY_AND_SOME;

  let after = date.getTime();
  while (after - before > 1) {
    const mid = before + Math.floor((after - before) / 2);
    if (isTheDay(mid)) after = mid;
    else before = mid;
  }
  return new Date(after);
}

export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}
