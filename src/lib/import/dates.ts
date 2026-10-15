const pad = (n: number) => String(n).padStart(2, "0");

function day(year: number, month: number, date: number): string | null {
  const at = new Date(Date.UTC(year, month - 1, date));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== date) return null;
  return `${year}-${pad(month)}-${pad(date)}`;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  sty: 1, lut: 2, kwi: 4, maj: 5, cze: 6, lip: 7, sie: 8, wrz: 9, paź: 10, paz: 10, lis: 11, gru: 12,
};

// Jira's default format, e.g. "15/Oct/26 9:30 AM", with English or Polish month names
const JIRA = /^(\d{1,2})\/([a-ząćęłńóśźż]{3,4})\/(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?:\s*([ap])\.?m\.?)?)?$/i;

function jira(value: string): { date: string; time: string | null } | null {
  const m = JIRA.exec(value);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase().slice(0, 3)] ?? MONTHS[m[2].toLowerCase()];
  const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  const date = month ? day(year, month, +m[1]) : null;
  if (!date) return null;
  if (m[4] === undefined) return { date, time: null };
  let hour = +m[4];
  if (m[6]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (m[6].toLowerCase() === "p" ? 12 : 0);
  }
  return hour > 23 ? null : { date, time: `${pad(hour)}:${m[5]}:00` };
}

// Day first with dots (Polish and German Excel); with slashes only when one part cannot be a month
export function normaliseDay(raw: string): string {
  const value = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d.*)?$/.exec(value);
  if (iso) return day(+iso[1], +iso[2], +iso[3]) ?? value;
  const fromJira = jira(value);
  if (fromJira) return fromJira.date;
  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s.*)?$/.exec(value);
  if (dotted) return day(+dotted[3], +dotted[2], +dotted[1]) ?? value;
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s.*)?$/.exec(value);
  if (slashed) {
    const [a, b, year] = [+slashed[1], +slashed[2], +slashed[3]];
    if (a > 12 && b <= 12) return day(year, b, a) ?? value;
    if (b > 12 && a <= 12) return day(year, a, b) ?? value;
  }
  return value;
}

// A time with no zone is read as UTC, so the same sheet means the same instant on every server
export function normaliseInstant(raw: string): string {
  const value = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(value);
  if (iso) {
    const date = day(+iso[1], +iso[2], +iso[3]);
    if (!date) return value;
    const zone = !iso[8] ? "Z" : /^[+-]\d{2}$/.test(iso[8]) ? `${iso[8]}:00` : iso[8].toUpperCase();
    return `${date}T${pad(+iso[4])}:${iso[5]}:${iso[6] ?? "00"}${iso[7] ? `.${iso[7]}` : ""}${zone}`;
  }
  const fromJira = jira(value);
  if (fromJira) return `${fromJira.date}T${fromJira.time ?? "00:00:00"}Z`;
  const parts = /^(\S+)(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
  // Anything else carrying a time is left for the import to refuse and report, not read as midnight
  if (!parts || /[T:]/i.test(parts[1])) return value;
  const date = normaliseDay(parts[1]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return value;
  return `${date}T${pad(+(parts[2] ?? 0))}:${parts[3] ?? "00"}:${parts[4] ?? "00"}Z`;
}
