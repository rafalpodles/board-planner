import { Types } from "mongoose";
import type { ScopedDb } from "./db-scope";
import { exportedRows, line, stillThere } from "./organisation-life-cycle";
import { organisationUploads, UPLOAD_BUCKET } from "./upload-ownership";

export const PROJECT_EXPORT_FORMAT = "board-planner-project-export";
export const PROJECT_EXPORT_VERSION = 1;
const TASKS_PER_QUERY = 1000;
const PEOPLE_PER_QUERY = 1000;

// Named by what they hold; people are written from what the other rows point at, not from this list
const PROJECT_COLLECTIONS = ["Project", "Sprint", "Task", "Comment", "ActivityLog", "ProjectAuditLog", "Agent", "AgentRun", "PmMessage", "Grant"] as const;
const PEOPLE_FIELDS = ["username", "fullName"];

export class ProjectExportCutShortError extends Error {
  constructor() {
    super("The project was deleted while this export was being made, so what was sent is incomplete");
    this.name = "ProjectExportCutShortError";
  }
}

function idsIn(node: unknown, into: Set<string>): void {
  if (node === null || typeof node !== "object" || node instanceof Date) return;
  if ((node as { _bsontype?: string })._bsontype === "ObjectId") {
    into.add(String(node));
    return;
  }
  for (const child of Array.isArray(node) ? node : Object.values(node)) idsIn(child, into);
}

// A project export is one project's rows in the organisation export's shape, so one reader serves both
export async function* projectExport(db: ScopedDb, project: Types.ObjectId): AsyncGenerator<string> {
  const stillThereProject = async () => {
    await stillThere(db.organisation);
    if ((await db.Project.exists({ _id: project })) === null) throw new ProjectExportCutShortError();
  };
  yield line({
    format: PROJECT_EXPORT_FORMAT,
    version: PROJECT_EXPORT_VERSION,
    organisation: db.organisation,
    project,
    exportedAt: new Date(),
    collections: [...PROJECT_COLLECTIONS, "User", `${UPLOAD_BUCKET}.files`, `${UPLOAD_BUCKET}.chunks`],
    reduced: { User: PEOPLE_FIELDS },
  });

  const named = new Set<string>();
  const taskIds: Types.ObjectId[] = [];
  const filters: Record<(typeof PROJECT_COLLECTIONS)[number], Record<string, unknown> | null> = {
    Project: { _id: project },
    Sprint: { project },
    Task: { project },
    Comment: null,
    ActivityLog: null,
    ProjectAuditLog: { project },
    Agent: { scope: "project", project },
    AgentRun: { project },
    PmMessage: { project },
    Grant: { objectType: "project", object: project },
  };

  for (const name of PROJECT_COLLECTIONS) {
    await stillThereProject();
    const remember = (document: Record<string, unknown>) => {
      if (name === "Task") taskIds.push(document._id as Types.ObjectId);
      for (const [key, value] of Object.entries(document)) if (key !== "_id") idsIn(value, named);
    };
    const filter = filters[name];
    if (filter) {
      yield* exportedRows(db, name, filter, remember);
      continue;
    }
    for (let at = 0; at < taskIds.length; at += TASKS_PER_QUERY) {
      yield* exportedRows(db, name, { task: { $in: taskIds.slice(at, at + TASKS_PER_QUERY) } }, remember);
    }
  }

  await stillThereProject();
  const people = [...named];
  for (let at = 0; at < people.length; at += PEOPLE_PER_QUERY) {
    const rows = await db.User.find({ _id: { $in: people.slice(at, at + PEOPLE_PER_QUERY) } })
      .select(PEOPLE_FIELDS.join(" "))
      .sort({ _id: 1 })
      .lean();
    for (const row of rows) yield line({ collection: "User", document: { _id: row._id, username: row.username, fullName: row.fullName } });
  }

  const uploads = organisationUploads(db);
  if (uploads) {
    let sent = 0;
    for await (const row of uploads.rows(project)) {
      if (sent++ % 500 === 0) await stillThereProject();
      yield line(row);
    }
  }
}
