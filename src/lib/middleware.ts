import { NextResponse } from "next/server";
import { isValidObjectId, Types } from "mongoose";
import { getAuthUser, RateLimitError } from "./auth";
import { connectDB } from "./db";
import { verifyWorkerCredential } from "./worker-service";
import { Project } from "@/models/project";
import { Task } from "@/models/task";
import { IProject, IUser, IWorker } from "@/types";

type AuthenticatedHandler = (
  request: Request,
  context: { params: Promise<Record<string, string>>; user: IUser }
) => Promise<NextResponse | Response>;

export function withAuth(handler: AuthenticatedHandler) {
  return async (
    request: Request,
    context: { params: Promise<Record<string, string>> }
  ) => {
    let user: IUser | null;
    try {
      user = await getAuthUser(request);
    } catch (e) {
      if (e instanceof RateLimitError) {
        return NextResponse.json({ error: e.message }, { status: 429 });
      }
      throw e;
    }

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return handler(request, { ...context, user });
  };
}

export function withAdmin(handler: AuthenticatedHandler) {
  return withAuth(async (request, context) => {
    if (context.user.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handler(request, context);
  });
}

export function protocolOf(request: Request): number {
  return Number(request.headers.get("x-cp-protocol") ?? NaN);
}

export function withWorker(
  handler: (
    request: Request,
    context: { params: Promise<Record<string, string>>; worker: IWorker }
  ) => Promise<Response>
) {
  return async (request: Request, context: { params: Promise<Record<string, string>> }) => {
    const header = request.headers.get("authorization") ?? "";
    const workerId = request.headers.get("x-worker-id") ?? "";
    if (!header.startsWith("Bearer ") || !workerId) {
      return NextResponse.json({ error: "Worker credential required" }, { status: 401 });
    }

    const worker = await verifyWorkerCredential(workerId, header.slice("Bearer ".length));
    if (!worker) {
      return NextResponse.json({ error: "Worker credential rejected" }, { status: 401 });
    }
    // credentialHash is only loaded to verify the credential above; clear it so no
    // downstream handler can spread it into a response
    worker.credentialHash = "";

    // The path segment is authoritative on /api/workers/:id, so a credential must not act on
    // someone else's record just because the route happens to carry an id
    const params = await context.params;
    if (params.workerId && params.workerId !== String(worker._id)) {
      return NextResponse.json({ error: "Not your worker" }, { status: 403 });
    }

    return handler(request, { ...context, worker });
  };
}

function refId(ref: Types.ObjectId | IUser): string {
  const populated = (ref as { _id?: Types.ObjectId })._id;
  return (populated ?? ref).toString();
}

export function canAdminProject(
  user: IUser,
  project: Pick<IProject, "_id" | "owner" | "admins">
): boolean {
  if (user.role === "admin") return true;
  if (user.tokenScoped) return false;
  const uid = user._id.toString();
  if (project.owner && refId(project.owner) === uid) return true;
  const listed = (project.admins || []).some((a) => refId(a) === uid);
  if (!listed) return false;
  // A listed admin whose project access was later revoked loses admin rights too
  const projectId = project._id.toString();
  return (user.allowedProjects || []).some((p) => p.toString() === projectId);
}

const PROJECT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/;
// "146" or "CP-146" — the project is already pinned by the projectId segment,
// so only the number is used and any key prefix is decoration
const TASK_NUMBER_PATTERN = /^(?:[A-Za-z][A-Za-z0-9_-]*-)?(\d{1,9})$/;

export async function resolveProjectId(identifier: string): Promise<string | null> {
  if (isValidObjectId(identifier)) return identifier;
  if (!PROJECT_KEY_PATTERN.test(identifier)) return null;
  await connectDB();
  const project = await Project.findOne({ key: identifier.toUpperCase() }).select("_id");
  return project ? project._id.toString() : null;
}

export async function resolveTaskId(
  projectId: string,
  identifier: string
): Promise<string | null> {
  if (isValidObjectId(identifier)) return identifier;
  const match = TASK_NUMBER_PATTERN.exec(identifier);
  if (!match) return null;
  await connectDB();
  const task = await Task.findOne({
    project: projectId,
    taskNumber: Number(match[1]),
  }).select("_id");
  return task ? task._id.toString() : null;
}

// Handlers query Mongo with params.projectId/taskId, so they must always see ObjectIds
async function withResolvedIds(
  context: { params: Promise<Record<string, string>>; user: IUser },
  params: Record<string, string>,
  projectId: string
): Promise<
  | { ok: true; context: { params: Promise<Record<string, string>>; user: IUser } }
  | { ok: false; response: NextResponse }
> {
  const resolved: Record<string, string> = { ...params, projectId };

  if (params.taskId) {
    if (!isValidObjectId(params.taskId) && !TASK_NUMBER_PATTERN.test(params.taskId)) {
      return {
        ok: false,
        response: NextResponse.json({ error: "Invalid task id" }, { status: 400 }),
      };
    }
    const taskId = await resolveTaskId(projectId, params.taskId);
    // A well-formed number that matches nothing is a miss, not a malformed request.
    // ObjectIds resolve without a lookup, so those still 404 from the handler.
    if (!taskId) {
      return {
        ok: false,
        response: NextResponse.json({ error: "Task not found" }, { status: 404 }),
      };
    }
    resolved.taskId = taskId;
  }

  return { ok: true, context: { ...context, params: Promise.resolve(resolved) } };
}

// An unknown identifier must look the same to a non-admin as one they cannot
// reach, otherwise the 400/403 split turns into a project-key oracle
function unresolvedProject(user: IUser) {
  return user.role === "admin"
    ? NextResponse.json({ error: "Project not found" }, { status: 404 })
    : NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export function withProjectAdmin(handler: AuthenticatedHandler) {
  return withAuth(async (request, context) => {
    const { user } = context;

    const params = await context.params;
    const projectId = params.projectId ? await resolveProjectId(params.projectId) : null;
    if (!projectId) {
      return unresolvedProject(user);
    }

    if (user.role !== "admin") {
      if (user.tokenScoped) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }

      await connectDB();
      const project = await Project.findById(projectId).select("owner admins");
      if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
      if (!canAdminProject(user, project)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    const resolved = await withResolvedIds(context, params, projectId);
    if (!resolved.ok) return resolved.response;
    return handler(request, resolved.context);
  });
}

export function withProjectAccess(handler: AuthenticatedHandler) {
  return withAuth(async (request, context) => {
    const { user } = context;

    const params = await context.params;
    const projectId = params.projectId ? await resolveProjectId(params.projectId) : null;
    if (!projectId) {
      return unresolvedProject(user);
    }

    if (user.role !== "admin") {
      const allowedProjects = user.allowedProjects || [];
      const hasAccess = allowedProjects.some((p) => p.toString() === projectId);
      if (!hasAccess) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    const resolved = await withResolvedIds(context, params, projectId);
    if (!resolved.ok) return resolved.response;
    return handler(request, resolved.context);
  });
}
