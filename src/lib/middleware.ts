import { NextResponse } from "next/server";
import { isValidObjectId, type Types } from "mongoose";
import { getAuthUser } from "./auth";
import { ProvenanceError } from "./session";
import { connectDB } from "./db";
import { isDatabaseUnreachable } from "./db-errors";
import { check } from "./grants";
import { canServe, ownerReachableProjectIds, verifyWorkerCredential } from "./worker-service";
import { IUser, IWorker } from "@/types";
import { PROJECT_KEY_PATTERN } from "./urls";
import { matchRepo } from "./repo-match";
import { getOrganisation } from "./organisation";
import { scopedFor, organisationOf, type ScopedDb } from "./db-scope";
import { organisationOfRequest } from "./organisation-host";
import { can, FeatureKey } from "./entitlements";
import { projectRunsWorkers } from "@/lib/worker-gate";
import { EXECUTION_LEASE_MS } from "./execution-lease";
import { inOrganisation } from "./organisation-log";
import { asPrincipal, requestLimitRefusal } from "./organisation-limits";

type AuthenticatedHandler = (
  request: Request,
  context: {
    params: Promise<Record<string, string>>;
    user: IUser;
    db: ScopedDb;
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

export function hostNotFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function refusedOnThisHost(
  request: Request,
  principal: { organisation?: Types.ObjectId | null }
): Promise<NextResponse | null> {
  let host;
  try {
    host = await organisationOfRequest(request);
  } catch (e) {
    if (isDatabaseUnreachable(e)) return databaseUnavailable();
    throw e;
  }
  if (host.kind !== "organisation") return hostNotFound();
  if (!organisationOf(principal).equals(host.organisation)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
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
      const refused = await refusedOnThisHost(request, user);
      if (refused) return refused;
      const db = scopedFor(user);
      const overLimit = await requestLimitRefusal(db.organisation, asPrincipal(user));
      if (overLimit) return overLimit;
      return await inOrganisation(db.organisation, () => handler(request, { ...context, user, db }));
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

// 402, not 404 or 403, so the UI can upsell rather than treat this as missing or off-limits.
export async function entitlementRefusal(db: ScopedDb, feature: FeatureKey): Promise<NextResponse | null> {
  const organisation = await getOrganisation(db.organisation);
  if (can(organisation, feature)) return null;
  return NextResponse.json(
    { error: "This feature requires a plan upgrade", feature, plan: organisation.entitlements.plan },
    { status: 402 }
  );
}

/** Inside another guard, e.g. `withProjectOwner(requireEntitlement(feature, handler))`. */
export function requireEntitlement(feature: FeatureKey, handler: AuthenticatedHandler): AuthenticatedHandler {
  return async (request, context) => (await entitlementRefusal(context.db, feature)) ?? handler(request, context);
}

export function withEntitlement(feature: FeatureKey) {
  return (handler: AuthenticatedHandler) => withAuth(requireEntitlement(feature, handler));
}

export function protocolOf(request: Request): number {
  return Number(request.headers.get("x-cp-protocol") ?? NaN);
}

// A machine reaches what its owner reaches, and a deactivated owner reaches nothing (BP-832).
// Deactivating also scrambles the machine's credential; this is the second line.
async function ownerIsDeactivated(db: ScopedDb, worker: IWorker): Promise<boolean> {
  const ownerId = (worker.owner as { _id?: unknown } | null)?._id ?? worker.owner;
  return !!ownerId && !!(await db.User.exists({ _id: String(ownerId), deactivatedAt: { $ne: null } }));
}

function machineOwnerDeactivated() {
  return NextResponse.json({ error: "This machine's owner is deactivated" }, { status: 401 });
}

export function withWorker(
  handler: (
    request: Request,
    context: { params: Promise<Record<string, string>>; worker: IWorker; db: ScopedDb }
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

    const refusedHere = await refusedOnThisHost(request, worker);
    if (refusedHere) return refusedHere;
    if (await ownerIsDeactivated(scopedFor(worker), worker)) return machineOwnerDeactivated();

    // The path segment is authoritative on /api/workers/:id, so a credential must not act on
    // someone else's record just because the route happens to carry an id
    const params = await context.params;
    if (params.workerId && params.workerId !== String(worker._id)) {
      return NextResponse.json({ error: "Not your worker" }, { status: 403 });
    }

    const db = scopedFor(worker);
    const overLimit = await requestLimitRefusal(db.organisation, { id: String(worker._id) });
    if (overLimit) return overLimit;
    return inOrganisation(db.organisation, () => handler(request, { ...context, worker, db }));
  };
}

// "146" or "CP-146" — the project is already pinned by the projectId segment,
// so only the number is used and any key prefix is decoration
const TASK_NUMBER_PATTERN = /^(?:[A-Za-z][A-Za-z0-9_-]*-)?(\d{1,9})$/;

export async function resolveProjectId(db: ScopedDb, identifier: string): Promise<string | null> {
  if (isValidObjectId(identifier)) return identifier;
  if (!PROJECT_KEY_PATTERN.test(identifier)) return null;
  await connectDB();
  const project = await db.Project.findOne({ key: identifier.toUpperCase() }).select("_id");
  return project ? project._id.toString() : null;
}

export async function resolveTaskId(
  db: ScopedDb,
  projectId: string,
  identifier: string
): Promise<string | null> {
  if (isValidObjectId(identifier)) return identifier;
  const match = TASK_NUMBER_PATTERN.exec(identifier);
  if (!match) return null;
  await connectDB();
  const task = await db.Task.findOne({
    project: projectId,
    taskNumber: Number(match[1]),
  }).select("_id");
  return task ? task._id.toString() : null;
}

// Handlers query Mongo with params.projectId/taskId, so they must always see ObjectIds
async function withResolvedIds(
  context: { params: Promise<Record<string, string>>; user: IUser; db: ScopedDb },
  params: Record<string, string>,
  projectId: string
): Promise<
  | { ok: true; context: { params: Promise<Record<string, string>>; user: IUser; db: ScopedDb } }
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
    const taskId = await resolveTaskId(context.db, projectId, params.taskId);
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

// An unknown identifier must look the same to a non-admin as one they cannot reach, otherwise the
// 400/403 split turns into a project-key oracle; and to an admin as one in another organisation (BP-664)
function unresolvedProject(user: IUser) {
  return user.role === "admin"
    ? NextResponse.json({ error: "Project not found" }, { status: 404 })
    : NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export function withProjectOwner(handler: AuthenticatedHandler) {
  return withAuth(async (request, context) => {
    const { user } = context;

    const params = await context.params;
    const projectId = params.projectId ? await resolveProjectId(context.db, params.projectId) : null;
    if (!projectId) {
      return unresolvedProject(user);
    }

    if (!(await check(context.db, user, projectId, "admin"))) {
      return unresolvedProject(user);
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
// Keyed on runId, not workerId: workerId is left behind as history when a run ends, so a finished
// task would otherwise go on granting its worker access to the project for good.
async function holdsARunIn(db: ScopedDb, projectId: string, workerId: string, taskId?: string): Promise<boolean> {
  return (
    (await db.Task.exists({
      ...(taskId ? { _id: taskId } : {}),
      project: projectId,
      "execution.workerId": workerId,
      "execution.runId": { $nin: ["", null] },
    })) !== null
  );
}

// The rule the claim route applies to the id it is handed, so a record can only name an id
// that could have been claimed with.
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Whether this machine ran `runId` on this task, recently enough to still be reporting on it. The
 * claim stamps `execution.lastRunId`, and no exit clears it, so the answer survives the final status
 * change that unsets `execution.runId` — which is what the outcome record is sent after. A task
 * claimed before `lastRunId` existed carries none, and is then matched by the machine alone.
 *
 * Bounded by the lease, from the claim's own `startedAt`: past it the run would have been swept
 * anyway, and a machine its project no longer serves has no standing to write history there.
 */
async function ranThisRun(
  db: ScopedDb,
  projectId: string,
  workerId: string,
  taskId: string,
  runId: string
): Promise<boolean> {
  return (
    (await db.Task.exists({
      _id: taskId,
      project: projectId,
      "execution.workerId": workerId,
      "execution.startedAt": { $gte: new Date(Date.now() - EXECUTION_LEASE_MS) },
      $or: [{ "execution.lastRunId": runId }, { "execution.lastRunId": { $exists: false } }],
    })) !== null
  );
}

async function recordNamedBy(
  request: Request
): Promise<{ taskId: string; runId?: string } | "malformed"> {
  const body = await request
    .clone()
    .json()
    .catch(() => null);
  if (!body || typeof body.taskId !== "string" || !isValidObjectId(body.taskId)) return "malformed";
  if (body.runId === undefined) return { taskId: body.taskId };
  if (typeof body.runId !== "string" || !RUN_ID_PATTERN.test(body.runId)) return "malformed";
  return { taskId: body.taskId, runId: body.runId };
}

function notItsRun(machine: string, record: { taskId: string; runId?: string }) {
  console.warn(
    `runs: refused the record of run ${record.runId} on task ${record.taskId} from machine ${machine}`
  );
  // 422, not 403: a later claim only moves the task further from this run and the lease only runs
  // out, so the worker's outbox drops it rather than retrying it behind every later report
  return NextResponse.json({ error: "That run is not this machine's to record" }, { status: 422 });
}

/**
 * What a run this machine holds lets it reach when its project would otherwise refuse it.
 *
 * - `task` — a route naming a task reaches that task only if it is the one held. A route naming none
 *   gets nothing from a held run.
 * - `board` — the project's own read, which a run needs for its columns: reachable while this
 *   machine holds any run in the project.
 * - `runRecord` — `POST /runs`. A machine the project serves records what it always could. One it
 *   no longer serves records only the run it ran on the record's task, within the lease, since the
 *   record arrives after that run has released the task.
 */
export type WorkerReach = "task" | "board" | "runRecord";

export function withProjectAccessOrWorker(
  handler: AuthenticatedHandler,
  { reach = "task" }: { reach?: WorkerReach } = {}
) {
  const asPerson = withProjectAccess(handler);

  return async (request: Request, context: { params: Promise<Record<string, string>> }) => {
    const credential = request.headers.get("authorization") ?? "";
    const workerId = request.headers.get("x-worker-id") ?? "";
    if (!workerId || !credential.startsWith("Bearer ")) return asPerson(request, context);

    const worker = await verifyWorkerCredential(workerId, credential.slice("Bearer ".length));
    if (!worker) {
      return NextResponse.json({ error: "Worker credential rejected" }, { status: 401 });
    }
    if (!worker.enabled) {
      return NextResponse.json({ error: "this worker may not run" }, { status: 403 });
    }
    const refusedHere = await refusedOnThisHost(request, worker);
    if (refusedHere) return refusedHere;
    const db = scopedFor(worker);
    if (await ownerIsDeactivated(db, worker)) return machineOwnerDeactivated();
    const overLimit = await requestLimitRefusal(db.organisation, { id: String(worker._id) });
    if (overLimit) return overLimit;

    const params = await context.params;
    const projectId = params.projectId ? await resolveProjectId(db, params.projectId) : null;
    if (!projectId) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    await connectDB();
    const [project, reachable] = await Promise.all([
      db.Project.findById(projectId)
        .select("_id repositoryUrl githubRepo gitlabRepo gitlabHost worker")
        .lean(),
      ownerReachableProjectIds(db, worker),
    ]);
    const assigned =
      projectRunsWorkers(project?.worker) &&
      canServe(reachable, String(project._id)) &&
      matchRepo(project as never, worker.repos ?? []);
    const machine = String(worker._id);
    // A run this machine is holding right now goes through even when the answer above is no. That
    // is the paragraph at the top of this function, honoured for a case BP-358 introduced: the
    // reach is its owner's, so revoking a grant — or deploying this at all, since every machine
    // enrolled before BP-358 has no owner — would otherwise 403 the status, release and comment
    // routes of a task already in flight, and leave it in the active column until the two-hour
    // lease swept it and spent an attempt.
    //
    // Narrowed to the held task, with or without an instance admin's lock (BP-736, BP-758): holding
    // one run is no reason to reach any other task on the project.
    if (reach === "runRecord") {
      const record = await recordNamedBy(request);
      if (record === "malformed") {
        return NextResponse.json({ error: "taskId and runId must be ids" }, { status: 400 });
      }
      // Assigned, it is not narrowed by the run: the task is requeued by a released outcome and
      // can be claimed again before the outbox flushes, which moves lastRunId on
      if (!assigned && record.runId !== undefined) {
        if (!(await ranThisRun(db, projectId, machine, record.taskId, record.runId))) {
          return notItsRun(machine, record);
        }
      } else if (!assigned && !(await holdsARunIn(db, projectId, machine, record.taskId))) {
        // A worker from before BP-758 names no run: only the task it still holds
        return NextResponse.json(
          { error: "this worker is not assigned to this project" },
          { status: 403 }
        );
      }
    } else if (!assigned) {
      const heldTaskId = params.taskId ? await resolveTaskId(db, projectId, params.taskId) : null;
      const exempt =
        reach === "board"
          ? await holdsARunIn(db, projectId, machine)
          : !!heldTaskId && (await holdsARunIn(db, projectId, machine, heldTaskId));
      if (!exempt) {
        return NextResponse.json(
          { error: "this worker is not assigned to this project" },
          { status: 403 }
        );
      }
    }

    // It acts as its own identity, so a comment it leaves is authored by the machine rather than by
    // whoever's credential it was holding — the audit trail CP-241 exists to keep honest.
    const identity = worker.identity ? await db.User.findById(worker.identity) : null;
    if (!identity) {
      return NextResponse.json({ error: "this worker has no identity yet" }, { status: 403 });
    }
    identity.viaMachineCredential = true;

    const resolved = await withResolvedIds({ ...context, user: identity, db: scopedFor(identity) }, params, projectId);
    if (!resolved.ok) return resolved.response;
    return inOrganisation(resolved.context.db.organisation, () => handler(request, { ...resolved.context, workerId: machine }));
  };
}

export function withProjectAccess(handler: AuthenticatedHandler) {
  return withAuth(async (request, context) => {
    const { user } = context;

    const params = await context.params;
    const projectId = params.projectId ? await resolveProjectId(context.db, params.projectId) : null;
    if (!projectId) {
      return unresolvedProject(user);
    }

    if (!(await check(context.db, user, projectId, "access"))) {
      return unresolvedProject(user);
    }

    const resolved = await withResolvedIds(context, params, projectId);
    if (!resolved.ok) return resolved.response;
    return handler(request, resolved.context);
  });
}
