import { NextResponse } from "next/server";
import type { ScopedDb } from "@/lib/db-scope";
import { INSTANCE_AUDIT_ACTIONS, PROJECT_AUDIT_ACTIONS, type IUser } from "@/types";
import {
  auditExportStream,
  auditFilter,
  auditPages,
  exportFormat,
  exportResponse,
  parseAuditParams,
  NEXT_CURSOR_HEADER,
  type ExportShape,
} from "@/lib/audit-query";
import { INSTANCE_AUDIT_PAGE, PROJECT_AUDIT_PAGE } from "@/lib/audit-page-size";


type Person = { username?: string } | null | undefined;
type InstanceRow = { createdAt: Date; user: Person; actorUsername?: string; action: string; target: string; detail: string };
type ProjectRow = { createdAt: Date; user: Person | string; action: string; detail: string; lines?: string[] };

// Who the instance log names: the name as written, then the account, then a machine
const instanceActor = (row: InstanceRow) => row.actorUsername || row.user?.username || "system";
const projectActor = (row: ProjectRow) =>
  row.user && typeof row.user === "object" ? (row.user.username ?? "") : row.user === null ? "Deleted user" : "system";

const INSTANCE_SHAPE: ExportShape<InstanceRow> = {
  columns: ["createdAt", "actor", "action", "target", "detail"],
  record: (row) => ({
    createdAt: new Date(row.createdAt).toISOString(),
    actor: instanceActor(row),
    action: row.action,
    target: row.target ?? "",
    detail: row.detail ?? "",
  }),
};

const PROJECT_SHAPE: ExportShape<ProjectRow> = {
  columns: ["createdAt", "actor", "action", "detail"],
  record: (row) => ({
    createdAt: new Date(row.createdAt).toISOString(),
    actor: projectActor(row),
    action: row.action,
    detail: row.lines?.length ? row.lines.join("\n") : (row.detail ?? ""),
  }),
};

// An unscoped admin token sitting on a worker's disk is readable by the agent running there
export function machineRefusal(user: IUser): NextResponse | null {
  return user.viaMachineCredential
    ? NextResponse.json({ error: "Interactive session required" }, { status: 403 })
    : null;
}

async function auditReader(db: ScopedDb, request: Request, scope: { projectId?: string }) {
  const query = new URL(request.url).searchParams;
  const project = scope.projectId !== undefined;
  const parsed = parseAuditParams(
    query,
    project ? PROJECT_AUDIT_ACTIONS : INSTANCE_AUDIT_ACTIONS,
    project ? PROJECT_AUDIT_PAGE : INSTANCE_AUDIT_PAGE
  );
  if (!parsed.ok) return { ok: false, response: NextResponse.json({ error: parsed.error }, { status: 400 }) } as const;
  const filter = await auditFilter(
    db,
    project ? "project" : "instance",
    project ? { project: scope.projectId } : {},
    parsed.value
  );
  const model = project ? db.ProjectAuditLog : db.InstanceAuditLog;
  return { ok: true, params: parsed.value, query, read: auditPages(model, filter) } as const;
}

export async function auditList(db: ScopedDb, request: Request, scope: { projectId?: string }): Promise<NextResponse> {
  const reader = await auditReader(db, request, scope);
  if (!reader.ok) return reader.response;
  const page = await reader.read(reader.params.before, reader.params.limit);
  if (page === "unknown-cursor") return NextResponse.json({ error: "No entry with that id" }, { status: 400 });
  return NextResponse.json(page.rows, { headers: page.next ? { [NEXT_CURSOR_HEADER]: page.next } : {} });
}

export async function auditExport(
  db: ScopedDb,
  request: Request,
  scope: { projectId?: string; name: string }
): Promise<Response> {
  const reader = await auditReader(db, request, scope);
  if (!reader.ok) return reader.response;
  const format = exportFormat(reader.query);
  if (!format) return NextResponse.json({ error: "format must be csv or ndjson" }, { status: 400 });
  const stream =
    scope.projectId !== undefined
      ? auditExportStream(reader.read as never, PROJECT_SHAPE, format)
      : auditExportStream(reader.read as never, INSTANCE_SHAPE, format);
  return exportResponse(stream, scope.name, format);
}
