const pad = (n: number) => String(n).padStart(2, "0");

function day(year: number, month: number, date: number): string | null {
  const at = new Date(Date.UTC(year, month - 1, date));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== date) return null;
  return `${year}-${pad(month)}-${pad(date)}`;
}

// Day first with dots (Polish and German Excel); with slashes only when one part cannot be a month
export function normaliseDay(raw: string): string {
  const value = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d.*)?$/.exec(value);
  if (iso) return day(+iso[1], +iso[2], +iso[3]) ?? value;
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
  const parts = /^(\S+)(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
  // Anything else carrying a time is left for the import to refuse and report, not read as midnight
  if (!parts || /[T:]/i.test(parts[1])) return value;
  const date = normaliseDay(parts[1]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return value;
  return `${date}T${pad(+(parts[2] ?? 0))}:${parts[3] ?? "00"}:${parts[4] ?? "00"}Z`;
}
