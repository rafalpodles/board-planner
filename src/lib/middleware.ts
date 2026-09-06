import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { getAuthUser } from "./auth";
import { ProvenanceError } from "./session";
import { connectDB } from "./db";
import { isDatabaseUnreachable } from "./db-errors";
import { check } from "./grants";
import { canServe, ownerReachableProjectIds, verifyWorkerCredential } from "./worker-service";
import { Project } from "@/models/project";
import { User } from "@/models/user";
import { Task } from "@/models/task";
import { IUser, IWorker } from "@/types";
import { PROJECT_KEY_PATTERN } from "./urls";
import { matchRepo } from "./repo-match";

type AuthenticatedHandler = (
  request: Request,
  context: {
    params: Promise<Record<string, string>>;
    user: IUser;
    workerId?: string;
  }
) => Promise<NextResponse | Response>;

export function databaseUnavailable(): NextResponse {
  return NextResponse.json(
    { error: "The database is unreachable. This is not a problem with your session." },
    { status: 503, headers: { "Retry-After": "5" } }
  );
}

export function withAuth(handler: AuthenticatedHandler) {
  return async (
    request: Request,
    context: { params: Promise<Record<string, string>> }
  ) => {
    let user: IUser | null;
    try {
      user = await getAuthUser(request);
    } catch (e) {
      if (e instanceof ProvenanceError) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      if (isDatabaseUnreachable(e)) return databaseUnavailable();
      throw e;
    }

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
      return await handler(request, { ...context, user });
    } catch (e) {
      if (isDatabaseUnreachable(e)) return databaseUnavailable();
      throw e;
    }
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
    worker.credentialHash = "";

    const params = await context.params;
    if (params.workerId && params.workerId !== String(worker._id)) {
      return NextResponse.json({ error: "Not your worker" }, { status: 403 });
    }

    return handler(request, { ...context, worker });
  };
}

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

function unresolvedProject(user: IUser) {
  return user.role === "admin"
    ? NextResponse.json({ error: "Project not found" }, { status: 404 })
    : NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export function withProjectOwner(handler: AuthenticatedHandler) {
  return withAuth(async (request, context) => {
    const { user } = context;

    const params = await context.params;
    const projectId = params.projectId ? await resolveProjectId(params.projectId) : null;
    if (!projectId) {
      return unresolvedProject(user);
    }

    if (!(await check(user, projectId, "admin"))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const resolved = await withResolvedIds(context, params, projectId);
    if (!resolved.ok) return resolved.response;
    return handler(request, resolved.context);
  });
}

async function holdsARunIn(projectId: string, workerId: string): Promise<boolean> {
  return (
    (await Task.exists({
      project: projectId,
      "execution.workerId": workerId,
      "execution.runId": { $nin: ["", null] },
    })) !== null
  );
}

export function withProjectAccessOrWorker(handler: AuthenticatedHandler) {
  const asPerson = withProjectAccess(handler);

  return async (request: Request, context: { params: Promise<Record<string, string>> }) => {
    const credential = request.headers.get("authorization") ?? "";
    const workerId = request.headers.get("x-worker-id") ?? "";
    if (!workerId || !credential.startsWith("Bearer ")) return asPerson(request, context);

    const worker = await verifyWorkerCredential(workerId, credential.slice("Bearer ".length));
    if (!worker) {
      return NextResponse.json({ error: "Worker credential rejected" }, { status: 401 });
    }
    if (!worker.enabled || worker.lockedByInstance) {
      return NextResponse.json({ error: "this worker may not run" }, { status: 403 });
    }

    const params = await context.params;
    const projectId = params.projectId ? await resolveProjectId(params.projectId) : null;
    if (!projectId) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    await connectDB();
    const [project, reachable] = await Promise.all([
      Project.findById(projectId)
        .select("_id repositoryUrl githubRepo gitlabRepo gitlabHost worker")
        .lean(),
      ownerReachableProjectIds(worker),
    ]);
    const assigned =
      !!project?.worker?.enabled &&
      canServe(reachable, String(project._id)) &&
      matchRepo(project as never, worker.repos ?? []);
    if (!assigned && !(await holdsARunIn(projectId, String(worker._id)))) {
      return NextResponse.json(
        { error: "this worker is not assigned to this project" },
        { status: 403 }
      );
    }

    const identity = worker.identity ? await User.findById(worker.identity) : null;
    if (!identity) {
      return NextResponse.json({ error: "this worker has no identity yet" }, { status: 403 });
    }
    identity.viaMachineCredential = true;

    const resolved = await withResolvedIds({ ...context, user: identity }, params, projectId);
    if (!resolved.ok) return resolved.response;
    return handler(request, { ...resolved.context, workerId: String(worker._id) });
  };
}

export function withProjectAccess(handler: AuthenticatedHandler) {
  return withAuth(async (request, context) => {
    const { user } = context;

    const params = await context.params;
    const projectId = params.projectId ? await resolveProjectId(params.projectId) : null;
    if (!projectId) {
      return unresolvedProject(user);
    }

    if (!(await check(user, projectId, "access"))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const resolved = await withResolvedIds(context, params, projectId);
    if (!resolved.ok) return resolved.response;
    return handler(request, resolved.context);
  });
}
