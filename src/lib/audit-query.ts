import { isValidObjectId, Types } from "mongoose";
import type { ScopedDb } from "@/lib/db-scope";

export const AUDIT_EXPORT_PAGE = 500;
export const AUDIT_MAX_PAGE = 500;
const ACTOR_MAX_LENGTH = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const NEXT_CURSOR_HEADER = "X-Next-Before";

export interface AuditParams {
  from?: Date;
  to?: Date;
  action?: string;
  actor?: string;
  before?: string;
  limit: number;
}

type Parsed = { ok: true; value: AuditParams } | { ok: false; error: string };

const ZONED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

// A bare day is that whole UTC day, so `to=2026-10-14` keeps its evening; an instant must name its zone
function parseBound(raw: string, end: boolean): Date | null {
  const day = DATE_ONLY.test(raw);
  if (!day && !ZONED_INSTANT.test(raw)) return null;
  const at = new Date(day ? `${raw}T00:00:00.000Z` : raw);
  if (Number.isNaN(at.getTime())) return null;
  const date = raw.slice(0, 10);
  if (new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) return null;
  return end && day ? new Date(at.getTime() + DAY_MS) : at;
}

export function parseAuditParams(
  query: URLSearchParams,
  actions: readonly string[],
  defaultLimit: number
): Parsed {
  const value: AuditParams = { limit: defaultLimit };

  const from = query.get("from");
  if (from) {
    const at = parseBound(from, false);
    if (!at) return { ok: false, error: "from must be a date" };
    value.from = at;
  }
  const to = query.get("to");
  if (to) {
    const at = parseBound(to, true);
    if (!at) return { ok: false, error: "to must be a date" };
    value.to = at;
  }
  if (value.from && value.to && value.from >= value.to) {
    return { ok: false, error: "from must be before to" };
  }

  const action = query.get("action");
  if (action) {
    if (!actions.includes(action)) return { ok: false, error: "Unknown action" };
    value.action = action;
  }

  const actor = query.get("actor")?.trim();
  if (actor) {
    if (actor.length > ACTOR_MAX_LENGTH) return { ok: false, error: "actor is too long" };
    value.actor = actor;
  }

  const before = query.get("before");
  if (before) {
    if (!isValidObjectId(before) || before.length !== 24) return { ok: false, error: "before must be an entry id" };
    value.before = before;
  }

  const limit = query.get("limit");
  if (limit !== null) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > AUDIT_MAX_PAGE) {
      return { ok: false, error: `limit must be a whole number from 1 to ${AUDIT_MAX_PAGE}` };
    }
    value.limit = n;
  }

  return { ok: true, value };
}

type Filter = Record<string, unknown>;

/**
 * The rows the parameters name, or null when they name nobody. `actor` is a username: the instance
 * log matches the name it denormalised at the time as well as the account, so a deleted account's
 * rows are still found by the name they were written under.
 */
export async function auditFilter(
  db: ScopedDb,
  kind: "instance" | "project",
  base: Filter,
  params: AuditParams
): Promise<Filter | null> {
  const and: Filter[] = [base];
  if (params.from || params.to) {
    and.push({ createdAt: { ...(params.from && { $gte: params.from }), ...(params.to && { $lt: params.to }) } });
  }
  if (params.action) and.push({ action: params.action });
  if (params.actor) {
    const account = await db.User.findOne({ username: params.actor }).select("_id").lean<{ _id: Types.ObjectId }>();
    if (kind === "instance") {
      and.push({ $or: [{ actorUsername: params.actor }, ...(account ? [{ user: account._id }] : [])] });
    } else if (account) {
      and.push({ user: account._id });
    } else {
      return null;
    }
  }
  return and.length === 1 ? base : { $and: and };
}

export interface AuditPage<T> {
  rows: T[];
  next: string | null;
}

type AuditModel = ScopedDb["InstanceAuditLog"] | ScopedDb["ProjectAuditLog"];

export type PageReader<T> = (before: string | undefined, limit: number) => Promise<AuditPage<T> | "unknown-cursor">;

/**
 * Newest first, and stable: `_id` breaks a tie on `createdAt`, and the cursor is the last row's own
 * position rather than an offset, so a row written while somebody pages does not shift the next page.
 */
export function auditPages<T>(model: AuditModel, filter: Filter | null): PageReader<T> {
  return async (before, limit) => {
    if (!filter) return { rows: [], next: null };
    let where = filter;
    if (before) {
      const cursor = await (model as ScopedDb["InstanceAuditLog"])
        .findOne({ $and: [filter, { _id: before }] })
        .select("createdAt")
        .lean<{ _id: Types.ObjectId; createdAt: Date }>();
      if (!cursor) return "unknown-cursor";
      where = {
        $and: [
          filter,
          {
            $or: [
              { createdAt: { $lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, _id: { $lt: cursor._id } },
            ],
          },
        ],
      };
    }
    const found = (await (model as ScopedDb["InstanceAuditLog"])
      .find(where)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .populate("user", "username fullName")
      .lean()) as unknown as (T & { _id: Types.ObjectId })[];
    const rows = found.slice(0, limit);
    return { rows, next: found.length > limit ? String(rows[rows.length - 1]._id) : null };
  };
}

export type ExportFormat = "csv" | "ndjson";

export function exportFormat(query: URLSearchParams): ExportFormat | null {
  const format = query.get("format") ?? "csv";
  return format === "csv" || format === "ndjson" ? format : null;
}

const FORMULA_START = /^[=+\-@\t\r]/;

// A spreadsheet runs a cell that starts with one of these, and `detail` is text people typed
export function csvCell(value: unknown): string {
  let text = value instanceof Date ? value.toISOString() : String(value ?? "");
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(values: unknown[]): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}

export interface ExportShape<T> {
  columns: string[];
  record: (row: T) => Record<string, unknown>;
}

/**
 * One page per pull, so what is held at once is one page however long the log is; the browser
 * receives it as it is read.
 */
export function auditExportStream<T>(read: PageReader<T>, shape: ExportShape<T>, format: ExportFormat): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let before: string | undefined;
  let started = false;
  let done = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started && format === "csv") controller.enqueue(encoder.encode(csvLine(shape.columns)));
      started = true;
      if (done) return controller.close();
      const page = await read(before, AUDIT_EXPORT_PAGE);
      if (page === "unknown-cursor") {
        controller.error(new Error("The log moved under the export"));
        return;
      }
      const text = page.rows
        .map((row) => {
          const record = shape.record(row);
          return format === "csv" ? csvLine(shape.columns.map((c) => record[c])) : `${JSON.stringify(record)}\n`;
        })
        .join("");
      if (text) controller.enqueue(encoder.encode(text));
      before = page.next ?? undefined;
      if (!page.next) {
        done = true;
        controller.close();
      }
    },
  });
}

export function exportResponse(stream: ReadableStream<Uint8Array>, name: string, format: ExportFormat): Response {
  const day = new Date().toISOString().slice(0, 10);
  return new Response(stream, {
    headers: {
      "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}-${day}.${format}"`,
      "Cache-Control": "no-store",
    },
  });
}
