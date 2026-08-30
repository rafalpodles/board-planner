/**
 * Building an `Intl.DateTimeFormat` is the expensive part, and `startOfDayInTimezone` asks the
 * same question of the same zone about thirty times per call. Instances are stateless, so one per
 * zone is kept.
 *
 * Bounded, because the key is NOT canonical: `Intl` accepts "EuRoPe/WaRsAw", so `isValidTimezone`
 * agrees and a stored zone can differ from another in case alone — 2^26 of them for that one name,
 * every one a distinct entry. Canonicalising the key would cost the construction this exists to
 * avoid, so the map is emptied instead once it passes more zones than a deployment has. The thirty
 * calls in a row that motivate it all share one key, so a cleared map costs one rebuild.
 */
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

  /**
   * A day runs to 25 hours where the clocks go back, and to about 48 where a zone crossed the date
   * line by repeating a calendar date — Pacific/Apia did exactly that in 1892. So the lower bound
   * is stepped back until it is genuinely a different day rather than assumed to be one after a
   * single span: returning it unchecked handed back an arbitrary instant from the middle of the
   * day, which is not what this function is for.
   */
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
