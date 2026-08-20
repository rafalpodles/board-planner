import crypto from "crypto";
import bcrypt from "bcryptjs";
import { isValidObjectId, Types } from "mongoose";
import { connectDB } from "./db";
import { Worker } from "@/models/worker";
import { ApiUserSummary, ApiWorker, ApiWorkerTask, IUser, IWorker } from "@/types";
import { PROJECT_POLICY_DEFAULTS, WORKER_POLICY_DEFAULTS } from "@/lib/worker-policy";
import { MatchableProject, RepoReport, matchRepo } from "@/lib/repo-match";
import { projectRepositoryUrl } from "@/lib/repository";
import { ensureWorkerUser } from "@/lib/worker-user";
import { accessibleProjectIds } from "@/lib/grants";
import { User } from "@/models/user";

export const PROTOCOL_VERSION = 1;
export const WORKER_STALE_MS = 5 * 60 * 1000;
export const WORKER_HEARTBEAT_MS = 60 * 1000;

export type Verdict = { ok: true } | { ok: false; reason: string };

/**
 * The projects this machine may serve: the ones its owner can reach, resolved on every call.
 *
 * BP-358 removed the stored per-worker list an admin used to approve. That list was the right shape
 * while a machine took work assigned to a project-wide nominee — anyone's work — so admitting it to
 * a project was an instance-level decision. A machine now runs only its owner's own work, entirely
 * inside permissions that person already holds, so the list had nothing left to decide that the
 * owner's own grants do not. Resolving it live also means a revoked grant reaches the machine on
 * its next poll instead of leaving a stale approval behind.
 *
 * `null` means no restriction, which is what `accessibleProjectIds` returns for an instance admin.
 * An empty array means this machine reaches nothing — a worker with no owner, or one whose owner
 * has been deleted.
 */
export async function ownerReachableProjectIds(
  worker: Pick<IWorker, "owner">
): Promise<string[] | null> {
  if (!worker.owner) return [];
  await connectDB();
  const owner = await User.findById(worker.owner);
  if (!owner) return [];
  // The stored account, with none of getAuthUser's runtime narrowing on it — so this is that
  // person's whole reach rather than the reach of whatever credential they happened to hold at
  // enrolment. That is the right answer: enrolling always goes through an interactive session, and
  // a machine credential is refused there, so there is no narrowed principal to inherit.
  return accessibleProjectIds(owner);
}

export function canServe(reachable: string[] | null, projectId: string): boolean {
  return reachable === null || reachable.includes(projectId);
}

export function verdictFor(
  worker: IWorker,
  project: AssignableProject | null,
  requestProtocol: number,
  now = new Date(),
  // Every live worker on this instance. Without them a worker that lost a contested checkout would
  // still be allowed to claim for it — the assignment would be withheld while the claim went
  // through, which is the same working tree shared by two processes.
  others: CheckoutClaimant[] = [],
  // What ownerReachableProjectIds() answered for this machine. Defaults to reaching nothing, so a
  // caller that forgets it is refused rather than trusted.
  reachable: string[] | null = []
): Verdict {
  if (requestProtocol !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: `this worker speaks protocol ${requestProtocol || "none"}; the server speaks ${PROTOCOL_VERSION}`,
    };
  }
  if (!worker.enabled) return { ok: false, reason: "this worker is disabled" };
  if (worker.lockedByInstance) return { ok: false, reason: "this worker is locked by the instance" };

  // A non-finite lastSeenAt (unparseable, missing) must count as maximally stale, not as fresh
  const seenAt = worker.lastSeenAt ? new Date(worker.lastSeenAt).getTime() : NaN;
  const isFresh = Number.isFinite(seenAt) && now.getTime() - seenAt <= WORKER_STALE_MS;
  if (!isFresh) return { ok: false, reason: "this worker has not reported in" };

  // Assignment is no longer stored on the worker: it is the project being enabled AND its owner
  // being able to reach it AND this machine reporting a checkout of that project's repository —
  // the three checks below, in that order. Deciding it here keeps them in one place rather than
  // trusting a list the server would have had to write.
  if (!project?.worker?.enabled) {
    return { ok: false, reason: "this project is not enabled for workers" };
  }
  // Ownership first, because it is the answer to both questions: an ownerless machine reaches
  // nothing, and saying so beats saying it cannot reach this particular project.
  if (!worker.owner) {
    return { ok: false, reason: "this machine has no owner — enrol it again from the machine" };
  }
  // The repos a worker reports are self-asserted and a remote is public information, so they can
  // only narrow what its owner can already reach — never stand in for it (BP-305)
  if (!canServe(reachable, String(project._id))) {
    return { ok: false, reason: "this machine's owner cannot reach this project" };
  }
  const usable = usableRepos(worker as unknown as CheckoutClaimant, others, now);
  if (!matchRepo(project, usable)) {
    const lost = lostCheckouts(worker as unknown as CheckoutClaimant, others, now);
    const holder = matchRepo(project, worker.repos ?? []) ? [...lost.values()][0] : null;
    return {
      ok: false,
      reason: holder
        ? `${holder} already runs this checkout on the same machine`
        : "this worker reports no checkout of this project's repository",
    };
  }

  return { ok: true };
}

export interface ResolvedAssignment {
  project: string;
  // Exactly the string the worker reported. Never a path: the worker looks its own checkout up by
  // this, so the server has no way to name a directory on someone else's machine.
  remote: string;
  policy: Record<string, unknown>;
}

export interface AssignableProject extends MatchableProject {
  worker?: {
    enabled?: boolean;
    policy?: Record<string, unknown>;
    policyOverrides?: string[];
  };
}

function isLive(worker: IWorker, now: Date): boolean {
  if (!worker.enabled || worker.lockedByInstance) return false;
  const seenAt = worker.lastSeenAt ? new Date(worker.lastSeenAt).getTime() : NaN;
  return Number.isFinite(seenAt) && now.getTime() - seenAt <= WORKER_STALE_MS;
}

// Only what an operator actually set. Sending the stored policy would pin every field forever,
// because the schema materialises a default into each one at creation — so a changed default would
// reach nobody. The worker resolves the rest against its own copy of the defaults.
export function overriddenPolicy(
  holder: { policy?: Record<string, unknown> | null; policyOverrides?: string[] | null },
  known: Record<string, unknown>
): Record<string, unknown> {
  const stored = (holder.policy ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of holder.policyOverrides ?? []) {
    if (field in known && field in stored) out[field] = stored[field];
  }
  return out;
}

export const overriddenWorkerPolicy = (worker: IWorker) =>
  overriddenPolicy(worker as never, WORKER_POLICY_DEFAULTS);

// A project is offered to a worker when the operator enabled it there AND its owner can reach it
// AND that machine reports a checkout whose remote matches the project's repository. The path never
// travels; the remote does. An ownerless machine reaches nothing, which is `reachable` being empty
// rather than a separate gate — a non-empty list here is what a worker's own loop iterates and
// attempts to claim, so it must never carry a project the claim will refuse.
export function assignmentsFor(
  reported: RepoReport[],
  projects: AssignableProject[],
  reachable: string[] | null
): ResolvedAssignment[] {
  const out: ResolvedAssignment[] = [];
  for (const project of projects) {
    if (!project.worker?.enabled) continue;
    if (!canServe(reachable, String(project._id))) continue;
    const remote = matchRepo(project, reported);
    if (!remote) continue;
    out.push({
      project: String(project._id),
      remote,
      policy: overriddenPolicy(
        { policy: project.worker.policy, policyOverrides: project.worker.policyOverrides },
        PROJECT_POLICY_DEFAULTS
      ),
    });
  }
  return out;
}

// The same question assignmentsFor asks, minus the checkout — "what could this machine serve if
// somebody cloned the repository". assignmentsFor is deliberately silent about those, because it
// feeds a claim loop that must never iterate a project the claim would refuse; the app needs the
// other half, or adding a second project stays a git clone in a terminal that no screen mentions.
//
// No path and no policy here: this is a list to render and one address to clone from. The machine
// decides where its own checkout lives, exactly as it does for an assignment.
export function offersFor(
  reported: RepoReport[],
  projects: OfferableProject[],
  reachable: string[] | null
): ProjectOffer[] {
  const out: ProjectOffer[] = [];
  for (const project of projects) {
    if (!project.worker?.enabled) continue;
    if (!canServe(reachable, String(project._id))) continue;
    // Already served: offering it again invites a second clone of a repository this machine has
    if (matchRepo(project, reported)) continue;

    const repositoryUrl = projectRepositoryUrl(project);
    if (!repositoryUrl) continue;

    out.push({
      project: String(project._id),
      key: project.key ?? "",
      name: project.name ?? "",
      repositoryUrl,
    });
  }
  return out;
}

export interface ProjectOffer {
  project: string;
  // What the checkout is named on disk, and what the operator recognises it by. The app renders the
  // name; CloneStep keys the directory on the project key, as it does at onboarding.
  key: string;
  name: string;
  repositoryUrl: string;
}

export interface OfferableProject extends AssignableProject {
  key?: string;
  name?: string;
}

export interface CheckoutClaimant {
  _id: unknown;
  name: string;
  host: string;
  repos?: RepoReport[];
  enabled?: boolean;
  lockedByInstance?: boolean;
  lastSeenAt?: Date | string | null;
  createdAt?: Date | string;
}

function registeredAt(worker: CheckoutClaimant): number {
  const at = worker.createdAt ? new Date(worker.createdAt).getTime() : NaN;
  // A worker with no usable createdAt must never win by accident, so it sorts last
  return Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER;
}

// Two worker processes sharing one working tree both build worktrees in it and both run git in it.
// On different machines that cannot happen, so only a same-host, same-path pair collides.
//
// The winner is decided, not merely detected: the earliest-registered live claimant keeps the
// checkout. An earlier version answered symmetrically — both processes saw a collision and both
// stood down, leaving two idle workers and a green console.
export function lostCheckouts(
  worker: CheckoutClaimant,
  others: CheckoutClaimant[],
  now = new Date()
): Map<string, string> {
  const lost = new Map<string, string>();
  if (!isLive(worker as IWorker, now)) return lost;

  const mine = registeredAt(worker);
  const myId = String(worker._id);

  for (const other of others) {
    if (String(other._id) === myId) continue;
    if (!isLive(other as IWorker, now) || other.host !== worker.host) continue;

    const theirs = registeredAt(other);
    // Ties break on id so two workers created in the same millisecond still agree who wins
    const otherWins = theirs < mine || (theirs === mine && String(other._id) < myId);
    if (!otherWins) continue;

    const taken = new Set((other.repos ?? []).map((r) => r.path));
    for (const repo of worker.repos ?? []) {
      if (taken.has(repo.path)) lost.set(repo.path, other.name);
    }
  }
  return lost;
}

// The checkouts this worker may actually use: everything it reported, minus what an
// earlier-registered live process on the same machine already holds.
export function usableRepos(
  worker: CheckoutClaimant,
  others: CheckoutClaimant[],
  now = new Date()
): RepoReport[] {
  const lost = lostCheckouts(worker, others, now);
  return (worker.repos ?? []).filter((r) => !lost.has(r.path));
}

/**
 * A machine already belongs to somebody else.
 *
 * Registration upserts on name+host, so without this an enrolment would silently take over an
 * existing machine: mint a new credential (killing the process running there, whose stored one
 * stops working), rewrite `owner`, and inherit that record's reported checkouts. That was an
 * admin's act while enrolment needed approval. Since BP-358 anyone signed in can enrol, and the
 * enrolment-start route is unauthenticated and takes an arbitrary name and host — so guessing a
 * colleague's hostname would have been enough.
 */
export class WorkerAlreadyOwned extends Error {
  constructor() {
    super("That machine is already enrolled to somebody else");
    this.name = "WorkerAlreadyOwned";
  }
}

export async function registerWorker(input: {
  name: string;
  host: string;
  platform: string;
  version: string;
  // Whoever enrolled the machine. Only used to name the machine's identity.
  owner?: string;
  // The account the machine belongs to, which is what the claim and its reach key on.
  ownerId?: string;
}): Promise<{ worker: IWorker; credential: string }> {
  await connectDB();
  const credential = `cpw_${crypto.randomBytes(32).toString("hex")}`;
  const { owner, ownerId, ...fields } = input;

  // Read only to decide whether this record is changing hands — the authorization itself is the
  // filter below, atomically, because a read-then-write here would let two registrations racing on
  // the same name+host both see it unowned and the second silently overwrite the first's owner.
  const existing = await Worker.findOne({ name: fields.name, host: fields.host })
    .select("owner")
    .lean();
  // A record changing hands is a different machine as far as the server can tell, so it must not
  // inherit the last one's reported checkouts — those are paths on somebody else's disk, and the
  // worker re-reports its own inventory on its first heartbeat anyway.
  const adopted = !!existing && !existing.owner && !!ownerId;

  // Re-registration reclaims the identity rather than creating a ghost that holds the assignments
  // while the live worker sits idle with none — but only for a machine that is already yours, or
  // one nobody owns. Somebody else's is refused: the filter simply does not match it, so the upsert
  // tries to insert a duplicate name+host and the unique index answers, atomically.
  const mine = ownerId
    ? [{ owner: null }, { owner: { $exists: false } }, { owner: new Types.ObjectId(ownerId) }]
    : [{ owner: null }, { owner: { $exists: false } }];

  let worker;
  try {
    worker = await Worker.findOneAndUpdate(
      { name: fields.name, host: fields.host, $or: mine },
      {
        $set: {
          ...fields,
          ...(ownerId ? { owner: new Types.ObjectId(ownerId) } : {}),
          ...(adopted ? { repos: [], bindingError: "" } : {}),
          protocolVersion: PROTOCOL_VERSION,
          credentialHash: await bcrypt.hash(credential, 10),
          lastSeenAt: new Date(),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    if ((error as { code?: number })?.code === 11000) throw new WorkerAlreadyOwned();
    throw error;
  }
  if (!worker) throw new WorkerAlreadyOwned();

  // The user this machine will act as. Created after the worker so it can be keyed on the worker's
  // id, which is what makes two machines two identities rather than one shared "worker" account.
  const identity = await ensureWorkerUser({
    workerId: String(worker._id),
    machine: fields.name,
    owner: owner ?? "",
  });
  worker.identity = identity._id;
  await Worker.updateOne({ _id: worker._id }, { $set: { identity: identity._id } });

  return { worker: worker as IWorker, credential };
}

export async function verifyWorkerCredential(
  workerId: string,
  credential: string
): Promise<IWorker | null> {
  if (!isValidObjectId(workerId) || typeof credential !== "string") return null;
  await connectDB();
  // credentialHash is select: false on the schema; it must be asked for explicitly
  const worker = await Worker.findById(workerId).select("+credentialHash");
  if (!worker) return null;
  return (await bcrypt.compare(credential, worker.credentialHash)) ? worker : null;
}

export async function touchWorker(
  workerId: string,
  patch: Partial<
    Pick<IWorker, "protocolVersion" | "version" | "commandAckedAt" | "bindingError" | "preflight">
  > = {}
): Promise<void> {
  await connectDB();
  await Worker.updateOne({ _id: workerId }, { $set: { lastSeenAt: new Date(), ...patch } });
}

// Whose machine this is, rendered only when the caller populated it. An unpopulated ref is an id
// and no name, which would put "6a70…" in the column that exists to answer "whose is this" — so it
// reads as unknown instead, and the route that wants a name populates.
function apiOwner(owner: IWorker["owner"]): ApiUserSummary | null {
  const user = owner as IUser | null | undefined;
  if (!user || !user.username) return null;
  return { _id: String(user._id), username: user.username, fullName: user.fullName };
}

// Built field-by-field so credentialHash can never leak through, even if a caller
// passes in a document that was queried with it selected
export function toApiWorker(
  worker: IWorker,
  now = new Date(),
  currentTask?: ApiWorkerTask
): ApiWorker {
  const seenAt = worker.lastSeenAt ? new Date(worker.lastSeenAt).getTime() : NaN;
  const stale = !Number.isFinite(seenAt) || now.getTime() - seenAt > WORKER_STALE_MS;

  return {
    _id: String(worker._id),
    name: worker.name,
    host: worker.host,
    platform: worker.platform,
    version: worker.version,
    protocolVersion: worker.protocolVersion,
    repos: (worker.repos ?? []).map((r) => ({ remote: r.remote, path: r.path })),
    owner: apiOwner(worker.owner),
    policy: worker.policy,
    policyOverrides: [...(worker.policyOverrides ?? [])],
    enabled: worker.enabled,
    lockedByInstance: worker.lockedByInstance,
    lastSeenAt: worker.lastSeenAt ? new Date(worker.lastSeenAt).toISOString() : null,
    bindingError: worker.bindingError,
    preflight: worker.preflight
      ? {
          ok: worker.preflight.ok,
          account: worker.preflight.account,
          checks: (worker.preflight.checks ?? []).map((c) => ({
            name: c.name,
            ok: c.ok,
            detail: c.detail,
          })),
          reportedAt: new Date(worker.preflight.reportedAt).toISOString(),
        }
      : null,
    command: worker.command,
    commandIssuedAt: worker.commandIssuedAt ? new Date(worker.commandIssuedAt).toISOString() : null,
    commandAckedAt: worker.commandAckedAt ? new Date(worker.commandAckedAt).toISOString() : null,
    createdAt: new Date(worker.createdAt).toISOString(),
    updatedAt: new Date(worker.updatedAt).toISOString(),
    stale,
    ...(currentTask ? { currentTask } : {}),
  };
}
