/**
 * Building an `Intl.DateTimeFormat` is the expensive part, and `startOfDayInTimezone` asks the
 * same question of the same zone about thirty times per call. Instances are stateless, so one per
 * zone is kept; the set of zones a deployment uses is its projects', which is small.
 */
function formatter(kind: "hour" | "day", timeZone: string): Intl.DateTimeFormat {
  const key = `${kind}\u0000${timeZone}`;
  const cached = formatters.get(key);
  if (cached) return cached;
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

/** How far ahead of UTC the zone is at this instant, in milliseconds. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asIfUTC = Date.UTC(
    at("year"),
    at("month") - 1,
    at("day"),
    at("hour"),
    at("minute"),
    at("second")
  );
  // Both sides are whole seconds; the date's own milliseconds would otherwise leak into the offset
  return asIfUTC - Math.floor(date.getTime() / 1000) * 1000;
}

const A_DAY_AND_SOME = 26 * 60 * 60 * 1000;

/**
 * The instant at which the given zone's day containing `date` began — midnight *there*, not on the
 * server, which is what a "per day" allowance has to be counted from (BP-453). Railway runs UTC, so
 * a Warsaw project's day used to turn over at 02:00 local in summer.
 *
 * Searched rather than computed. Subtracting the zone's offset from wall midnight is wrong wherever
 * local midnight does not exist: America/Santiago springs forward *at* midnight, and the arithmetic
 * lands an hour into the previous day, so the count would take an hour of yesterday with it. The
 * search asks the only question that has an answer everywhere — is this instant already that day
 * there? — and the predicate is monotone because a day is one contiguous stretch.
 */
export function startOfDayInTimezone(date: Date, timeZone: string): Date {
  const key = dayKeyInTimezone(date, timeZone);
  const isTheDay = (t: number) => dayKeyInTimezone(new Date(t), timeZone) === key;

  let before = date.getTime() - A_DAY_AND_SOME;
  const within = date.getTime();
  // A day can run to 25 hours where the clocks go back, never to 26 — so `before` is the previous
  // day whatever the zone does. Asserted rather than assumed would need a throw; instead the loop
  // simply returns `within` if it ever were not, which is the safe direction for a cap.
  if (isTheDay(before)) return new Date(before);

  let after = within;
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
