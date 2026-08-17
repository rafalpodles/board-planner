import crypto from "crypto";
import bcrypt from "bcryptjs";
import { isValidObjectId, Types } from "mongoose";
import { connectDB } from "./db";
import { Worker } from "@/models/worker";
import { ApiWorker, ApiWorkerTask, IWorker } from "@/types";
import { PROJECT_POLICY_DEFAULTS, WORKER_POLICY_DEFAULTS } from "@/lib/worker-policy";
import { MatchableProject, RepoReport, matchRepo } from "@/lib/repo-match";
import { ensureWorkerUser } from "@/lib/worker-user";

export const PROTOCOL_VERSION = 1;
export const WORKER_STALE_MS = 5 * 60 * 1000;
export const WORKER_HEARTBEAT_MS = 60 * 1000;

export type Verdict = { ok: true } | { ok: false; reason: string };

export function approvedProjectIds(worker: Pick<IWorker, "approvedProjects">): string[] {
  return (worker.approvedProjects ?? []).map(String);
}

export function isApprovedFor(
  worker: Pick<IWorker, "approvedProjects">,
  projectId: string
): boolean {
  return approvedProjectIds(worker).includes(projectId);
}

export function verdictFor(
  worker: IWorker,
  project: AssignableProject | null,
  requestProtocol: number,
  now = new Date(),
  // Every live worker on this instance. Without them a worker that lost a contested checkout would
  // still be allowed to claim for it — the assignment would be withheld while the claim went
  // through, which is the same working tree shared by two processes.
  others: CheckoutClaimant[] = []
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

  // Assignment is no longer stored on the worker: it is the project being enabled AND this machine
  // reporting a checkout of that project's repository. Deciding it here keeps the check in one
  // place rather than trusting a list the server would have had to write.
  if (!project?.worker?.enabled) {
    return { ok: false, reason: "this project is not enabled for workers" };
  }
  // The repos a worker reports are self-asserted and a remote is public information, so they can
  // only narrow what an admin approved — never stand in for it (BP-305)
  if (!isApprovedFor(worker, String(project._id))) {
    return { ok: false, reason: "this worker was not approved for this project" };
  }
  if (!worker.owner) {
    return { ok: false, reason: "this machine has no owner — re-approve it from the board" };
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

// A project is offered to a worker when the operator enabled it there AND that machine reports a
// checkout whose remote matches the project's repository. The path never travels; the remote does.
// hasOwner gates the whole list rather than leaving it to the claim: a non-empty list here is what
// a worker's own loop iterates and attempts to claim, so an ownerless machine must see none of it,
// not a list it can only fail on.
export function assignmentsFor(
  reported: RepoReport[],
  projects: AssignableProject[],
  approved: string[],
  hasOwner: boolean
): ResolvedAssignment[] {
  if (!hasOwner) return [];
  const allowed = new Set(approved);
  const out: ResolvedAssignment[] = [];
  for (const project of projects) {
    if (!project.worker?.enabled) continue;
    if (!allowed.has(String(project._id))) continue;
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

export async function registerWorker(input: {
  name: string;
  host: string;
  platform: string;
  version: string;
  // Whoever minted the enrolment token. Only used to name the machine's identity.
  owner?: string;
  // The account the machine belongs to, which is what the claim keys on.
  ownerId?: string;
}): Promise<{ worker: IWorker; credential: string }> {
  await connectDB();
  const credential = `cpw_${crypto.randomBytes(32).toString("hex")}`;
  const { owner, ownerId, ...fields } = input;

  // Re-registration reclaims the identity rather than creating a ghost that holds the
  // assignments while the live worker sits idle with none
  const worker = await Worker.findOneAndUpdate(
    { name: fields.name, host: fields.host },
    {
      $set: {
        ...fields,
        ...(ownerId ? { owner: new Types.ObjectId(ownerId) } : {}),
        protocolVersion: PROTOCOL_VERSION,
        credentialHash: await bcrypt.hash(credential, 10),
        lastSeenAt: new Date(),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

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
    approvedProjects: approvedProjectIds(worker),
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
