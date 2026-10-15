import type { ImportBundle, ImportComment, ImportTask } from "./bundle";
import { normaliseDay, normaliseInstant } from "./dates";
import { jiraWikiToMarkdown } from "./jira-wiki";

export { normaliseDay, normaliseInstant } from "./dates";

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
  | "parent"
  | "comment"
  | `field:${string}`;

export interface CsvField {
  name: string;
  fieldType: string;
}

export interface CsvTable {
  headers: string[];
  rows: string[][];
  // How long text in it is written, when that is not plain or Markdown
  markup?: "jira-wiki";
  // Comments read from a format that keeps them apart from the columns, one list per row
  comments?: ImportComment[][];
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
  return withMarkup({ headers: headers.map((h) => h.trim()), rows });
}

export function withMarkup(table: CsvTable): CsvTable {
  return isJiraExport(table.headers) ? { ...table, markup: "jira-wiki" } : table;
}

const GUESSES: [CsvTarget, RegExp][] = [
  ["id", /^(id|key|issue key|issue id|task id|task key|klucz|klucz zgłoszenia|identyfikator|#)$/],
  ["title", /^(title|summary|name|task|task name|subject|tytuł|tytul|nazwa|zadanie|podsumowanie)$/],
  ["description", /^(description|details|body|notes|opis|szczegóły|szczegoly)$/],
  ["status", /^(status|state|column|stage|list|section|stan|kolumna)$/],
  ["assignee", /^(assignee|assigned to|owner|assignee email|responsible|przypisany|osoba|osoba przypisana|wykonawca)$/],
  ["priority", /^(priority|priorytet)$/],
  ["category", /^(type|issue type|category|kind|typ|typ zgłoszenia|kategoria)$/],
  ["dueDate", /^(due|due date|due on|deadline|termin|termin wykonania)$/],
  ["createdAt", /^(created|created at|created on|date created|utworzono|utworzone)$/],
  ["completedAt", /^(completed|completed at|resolved|resolution date|done at|closed|zakończono|zakonczono|rozwiązane|rozwiazane)$/],
  ["parent", /^(parent|parent key|parent id|parent issue|epic link|nadrzędne|nadrzedne)$/],
  ["comment", /^(comment|comments|komentarz|komentarze)$/],
];

// Jira writes one column per comment and per label, all under the same header
export function repeatable(target: CsvTarget, fields: CsvField[]): boolean {
  if (target === "comment") return true;
  return target.startsWith("field:") && fields.find((f) => `field:${f.name}` === target)?.fieldType === "multiselect";
}

export function isJiraExport(headers: string[]): boolean {
  const lower = new Set(headers.map((h) => h.trim().toLowerCase()));
  return (
    (lower.has("issue key") && lower.has("summary") && lower.has("issue type")) ||
    (lower.has("klucz zgłoszenia") && lower.has("podsumowanie") && lower.has("typ zgłoszenia"))
  );
}

export function guessTargets(headers: string[], fields: CsvField[]): CsvTarget[] {
  const taken = new Set<CsvTarget>();
  // Jira's Parent holds a numeric id; where its Parent key is there too, that is the one to show
  const parentKey = headers.findIndex((h) => h.trim().toLowerCase() === "parent key");
  if (parentKey >= 0) taken.add("parent");
  return headers.map((header, index) => {
    if (index === parentKey) return "parent";
    const wanted = header.trim().toLowerCase();
    const field = fields.find((f) => f.name.trim().toLowerCase() === wanted);
    const target: CsvTarget | undefined = field
      ? `field:${field.name}`
      : GUESSES.find(([, pattern]) => pattern.test(wanted))?.[0];
    if (!target || (taken.has(target) && !repeatable(target, fields))) return "ignore";
    taken.add(target);
    return target;
  });
}

// A run of the same header (Jira's Comment and Labels columns) counts once, so one more comment keeps the shape
export function headerRuns(headers: string[]): number[] {
  const starts: number[] = [];
  headers.forEach((h, i) => {
    if (i === 0 || h.trim().toLowerCase() !== headers[i - 1].trim().toLowerCase()) starts.push(i);
  });
  return starts;
}

export function shapeKey(headers: string[]): string {
  return headerRuns(headers)
    .map((i) => headers[i].trim().toLowerCase())
    .join("\u0001");
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

// Jira writes a comment as "15/Oct/26 9:30 AM;author;text"; anything else is the text alone
function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16);
}

// Known by its time and author where it has them, so a comment deleted in Jira does not shift the rest
function commentParts(cell: string): { at: string; author: string; body: string } | null {
  const parts = /^([^;\n]+);([^;\n]*);([\s\S]*)$/.exec(cell);
  const at = parts && normaliseInstant(parts[1]);
  return parts && at && /^\d{4}-\d{2}-\d{2}T/.test(at) ? { at, author: parts[2].trim(), body: parts[3] } : null;
}

// Everyone who wrote a comment, so each can be matched to a member like an assignee
export function commentAuthors(table: CsvTable, targets: CsvTarget[]): string[] {
  const seen = new Set<string>();
  targets.forEach((target, column) => {
    if (target !== "comment") return;
    for (const row of table.rows) {
      const author = commentParts(row[column] ?? "")?.author;
      if (author) seen.add(author);
    }
  });
  for (const list of table.comments ?? []) for (const c of list) if (c.author) seen.add(c.author);
  return [...seen];
}

function commentFrom(cell: string, ordinal: number, taken: ImportComment[], prose: (text: string) => string): ImportComment {
  const parts = commentParts(cell);
  if (parts) {
    const { at, author } = parts;
    const base = `${at}|${author.length > 60 ? `${author.slice(0, 50)}~${fnv(author)}` : author}`;
    const same = taken.filter((c) => c.id === base || c.id.startsWith(`${base}#`)).length;
    return { id: same ? `${base}#${same + 1}` : base, createdAt: at, ...(author && { author }), body: prose(parts.body) };
  }
  return { id: `c${ordinal}`, body: prose(cell) };
}

// `upload` names this upload alone: a row with no id of its own can then never match a task from another one
export function csvToBundle(table: CsvTable, targets: CsvTarget[], source: string, fields: CsvField[], upload: string): ImportBundle {
  const at = (target: CsvTarget) => targets.indexOf(target);
  const prose = (text: string) => (table.markup === "jira-wiki" && text ? jiraWikiToMarkdown(text) : text);
  const idColumn = at("id");
  // Jira's Parent column holds the parent's numeric Issue id; the key is what a person reads
  const issueId = table.headers.findIndex((h) => /^(issue id|identyfikator zgłoszenia)$/i.test(h.trim()));
  const keyOf = new Map(
    issueId >= 0 && idColumn >= 0 && issueId !== idColumn
      ? table.rows.map((r) => [(r[issueId] ?? "").trim(), (r[idColumn] ?? "").trim()] as const).filter(([a, b]) => a && b)
      : []
  );
  const tasks = table.rows.map((row, index): ImportTask => {
    const cell = (column: number) => (column < 0 ? "" : (row[column] ?? ""));
    const text = (target: CsvTarget) => cell(at(target)).trim() || undefined;
    const task: ImportTask = {
      id: idColumn < 0 ? `${NO_ID_PREFIX}${index + 2}` : cell(idColumn).trim() || `${upload}-${NO_ID_PREFIX}${index + 2}`,
      title: cell(at("title")),
      description: prose(cell(at("description"))) || undefined,
      status: text("status"),
      assignee: text("assignee"),
      priority: text("priority"),
      type: text("category"),
      dueDate: text("dueDate") && normaliseDay(text("dueDate")!),
      createdAt: text("createdAt") && normaliseInstant(text("createdAt")!),
      completedAt: text("completedAt") && normaliseInstant(text("completedAt")!),
    };
    const parent = text("parent");
    if (parent) task.parent = keyOf.get(parent) ?? parent;
    const values: Record<string, unknown> = {};
    const comments: ImportComment[] = [];
    targets.forEach((target, column) => {
      if (cell(column).trim() === "") return;
      if (target === "comment") return comments.push(commentFrom(cell(column), comments.length + 1, comments, prose));
      if (!target.startsWith("field:")) return;
      const name = target.slice("field:".length);
      const value = fieldValue(cell(column), fields.find((f) => f.name === name));
      const before = values[name];
      values[name] = Array.isArray(before) && Array.isArray(value) ? [...new Set([...before, ...value])] : value;
    });
    if (Object.keys(values).length) task.fields = values;
    const structured = table.comments?.[index] ?? [];
    if (structured.length || comments.length) task.comments = [...structured, ...comments];
    return Object.fromEntries(Object.entries(task).filter(([, v]) => v !== undefined)) as unknown as ImportTask;
  });
  return { source, tasks };
}
