import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { getAuthUser } from "./auth";
import { ProvenanceError } from "./session";
import { connectDB } from "./db";
import { isDatabaseUnreachable } from "./db-errors";
import { check } from "./grants";
import { verifyWorkerCredential, isApprovedFor } from "./worker-service";
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
    /**
     * Set only when this request authenticated as a worker and the credential was verified
     * against exactly this id. Handlers must use THIS and never read `x-worker-id` themselves:
     * a session cookie with no Bearer takes the person branch, where that header is attacker-set
     * and unverified (BP-336).
     */
    workerId?: string;
  }
) => Promise<NextResponse | Response>;

/**
 * The database could not be answered from, which is not the caller's fault and must not read as one.
 *
 * 503 rather than 401, because the browser client treats a 401 as "your session is gone" and clears
 * it — so an outage used to sign everybody out, and the sign-in they were sent to failed too, with
 * nothing anywhere naming the real cause (BP-362). Retry-After is short: the connection is retried
 * on the next request now that a failed one is no longer cached.
 */
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
      // isDatabaseUnreachable, not an instanceof: a database that dies while the app is
      // connected fails from the query rather than from connectDB, and that error is the
      // driver's own class (BP-362 review)
      if (isDatabaseUnreachable(e)) return databaseUnavailable();
      throw e;
    }

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // The handler too, not only the credential: resolveProjectId, the grant check and every route
    // body reach the database after this point, and a 500 there withholds the Retry-After a machine
    // client needs — while the middleware's own comment promised a 503 (BP-362 review)
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

// A worker reports on the tasks it runs with its own credential, rather than a second, static API
// token. The reason the second token cannot work: a worker's grant is recomputed every heartbeat
// from the checkouts it reports crossed with every enabled project, while a project-scoped API
// token is a list fixed when it was minted. Enable a second project and the worker is assigned it
// on its cpw_ credential while its cp_ token cannot write there — the task claims, the report 403s,
// and it sits in the active column until the lease expires.
//
// So the grant is re-derived here on every call, which makes the scope track the assignments by
// construction. Deliberately NOT the full claim-time verdict: a worker that lost a contested
// checkout must still be able to report the outcome of a task it already holds, or refusing it
// would strand that task — the failure this whole design keeps working to avoid.
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
    const project = await Project.findById(projectId)
      .select("_id repositoryUrl githubRepo gitlabRepo gitlabHost worker")
      .lean();
    if (
      !project?.worker?.enabled ||
      !isApprovedFor(worker, String(project._id)) ||
      !matchRepo(project as never, worker.repos ?? [])
    ) {
      return NextResponse.json(
        { error: "this worker is not assigned to this project" },
        { status: 403 }
      );
    }

    // It acts as its own identity, so a comment it leaves is authored by the machine rather than by
    // whoever's credential it was holding — the audit trail CP-241 exists to keep honest.
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
