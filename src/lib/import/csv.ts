import type { ImportBundle, ImportTask } from "./bundle";

export type CsvTarget =
  | "ignore"
  | "id"
  | "title"
  | "description"
  | "status"
  | "assignee"
  | "priority"
  | "category"
  | "dueDate"
  | "createdAt"
  | "completedAt"
  | `field:${string}`;

export interface CsvField {
  name: string;
  fieldType: string;
}

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

const DELIMITERS = [",", ";", "\t", "|"] as const;

// Excel saves a "CSV" in the machine's ANSI code page, which in Poland is windows-1250
export function decodeCsv(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1250").decode(bytes);
  }
}

function headerLine(text: string): string {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "\n" || c === "\r")) return text.slice(0, i);
  }
  return text;
}

export function detectDelimiter(text: string): string {
  const line = headerLine(text).replace(/"[^"]*"/g, "");
  let best: string = ",";
  let most = 0;
  for (const d of DELIMITERS) {
    const count = line.split(d).length - 1;
    if (count > most) {
      best = d;
      most = count;
    }
  }
  return best;
}

export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

export function readCsvTable(text: string): CsvTable {
  const [headers = [], ...rows] = parseCsv(text);
  return { headers: headers.map((h) => h.trim()), rows };
}

const GUESSES: [CsvTarget, RegExp][] = [
  ["id", /^(id|key|issue key|issue id|task id|task key|klucz|identyfikator|#)$/],
  ["title", /^(title|summary|name|task|task name|subject|tytuł|tytul|nazwa|zadanie)$/],
  ["description", /^(description|details|body|notes|opis|szczegóły|szczegoly)$/],
  ["status", /^(status|state|column|stage|list|section|stan|kolumna)$/],
  ["assignee", /^(assignee|assigned to|owner|assignee email|responsible|przypisany|osoba|wykonawca)$/],
  ["priority", /^(priority|priorytet)$/],
  ["category", /^(type|issue type|category|kind|typ|kategoria)$/],
  ["dueDate", /^(due|due date|due on|deadline|termin)$/],
  ["createdAt", /^(created|created at|created on|date created|utworzono)$/],
  ["completedAt", /^(completed|completed at|resolved|resolution date|done at|closed|zakończono|zakonczono)$/],
];

export function guessTargets(headers: string[], fields: CsvField[]): CsvTarget[] {
  const taken = new Set<CsvTarget>();
  return headers.map((header) => {
    const wanted = header.trim().toLowerCase();
    const field = fields.find((f) => f.name.trim().toLowerCase() === wanted);
    const target: CsvTarget | undefined = field
      ? `field:${field.name}`
      : GUESSES.find(([, pattern]) => pattern.test(wanted))?.[0];
    if (!target || taken.has(target)) return "ignore";
    taken.add(target);
    return target;
  });
}

export function shapeKey(headers: string[]): string {
  return headers.map((h) => h.trim().toLowerCase()).join("\u0001");
}

export function columnOf(targets: CsvTarget[], target: CsvTarget): number {
  return targets.indexOf(target);
}

export function distinctValues(table: CsvTable, column: number): string[] {
  if (column < 0) return [];
  const seen = new Set<string>();
  for (const row of table.rows) {
    const value = (row[column] ?? "").trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

const pad = (n: number) => String(n).padStart(2, "0");

function day(year: number, month: number, date: number): string | null {
  const at = new Date(Date.UTC(year, month - 1, date));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== date) return null;
  return `${year}-${pad(month)}-${pad(date)}`;
}

// Day first with dots (Polish and German Excel); with slashes only when one part cannot be a month
export function normaliseDay(raw: string): string {
  const value = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(value);
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

const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/i;

// A time with no zone is read as UTC, so the same sheet means the same instant on every server
export function normaliseInstant(raw: string): string {
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(value)) {
    const iso = value.replace(" ", "T");
    return ZONED.test(iso) ? iso : `${iso}Z`;
  }
  const parts = /^(\S+)(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
  if (!parts) return value;
  const date = normaliseDay(parts[1]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return value;
  return `${date}T${pad(+(parts[2] ?? 0))}:${parts[3] ?? "00"}:${parts[4] ?? "00"}Z`;
}

const TRUE = new Set(["true", "yes", "y", "1", "x", "tak", "✓", "✔"]);
const FALSE = new Set(["false", "no", "n", "0", "nie", ""]);

function fieldValue(raw: string, field: CsvField | undefined): unknown {
  const value = raw.trim();
  if (field?.fieldType === "checkbox") {
    const lower = value.toLowerCase();
    if (TRUE.has(lower)) return true;
    if (FALSE.has(lower)) return false;
    return value;
  }
  if (field?.fieldType === "multiselect") return value.split(",").map((v) => v.trim()).filter(Boolean);
  if (field?.fieldType === "number") return value.replace(/\s/g, "").replace(/^(-?\d+),(\d+)$/, "$1.$2");
  if (field?.fieldType === "date") return normaliseDay(value);
  return value;
}

export const NO_ID_PREFIX = "row-";

// `upload` names this upload alone: a row with no id of its own can then never match a task from another one
export function csvToBundle(table: CsvTable, targets: CsvTarget[], source: string, fields: CsvField[], upload: string): ImportBundle {
  const at = (target: CsvTarget) => targets.indexOf(target);
  const idColumn = at("id");
  const tasks = table.rows.map((row, index): ImportTask => {
    const cell = (column: number) => (column < 0 ? "" : (row[column] ?? ""));
    const text = (target: CsvTarget) => cell(at(target)).trim() || undefined;
    const task: ImportTask = {
      id: idColumn < 0 ? `${NO_ID_PREFIX}${index + 2}` : cell(idColumn).trim() || `${upload}-${NO_ID_PREFIX}${index + 2}`,
      title: cell(at("title")),
      description: cell(at("description")) || undefined,
      status: text("status"),
      assignee: text("assignee"),
      priority: text("priority"),
      type: text("category"),
      dueDate: text("dueDate") && normaliseDay(text("dueDate")!),
      createdAt: text("createdAt") && normaliseInstant(text("createdAt")!),
      completedAt: text("completedAt") && normaliseInstant(text("completedAt")!),
    };
    const values: Record<string, unknown> = {};
    targets.forEach((target, column) => {
      if (!target.startsWith("field:")) return;
      const name = target.slice("field:".length);
      if (cell(column).trim() === "") return;
      values[name] = fieldValue(cell(column), fields.find((f) => f.name === name));
    });
    if (Object.keys(values).length) task.fields = values;
    return Object.fromEntries(Object.entries(task).filter(([, v]) => v !== undefined)) as unknown as ImportTask;
  });
  return { source, tasks };
}
