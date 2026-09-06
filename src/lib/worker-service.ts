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

export async function ownerReachableProjectIds(
  worker: Pick<IWorker, "owner">
): Promise<string[] | null> {
  if (!worker.owner) return [];
  await connectDB();
  const owner = await User.findById(worker.owner);
  if (!owner) return [];
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
  others: CheckoutClaimant[] = [],
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

  const seenAt = worker.lastSeenAt ? new Date(worker.lastSeenAt).getTime() : NaN;
  const isFresh = Number.isFinite(seenAt) && now.getTime() - seenAt <= WORKER_STALE_MS;
  if (!isFresh) return { ok: false, reason: "this worker has not reported in" };

  if (!project?.worker?.enabled) {
    return { ok: false, reason: "this project is not enabled for workers" };
  }
  if (!worker.owner) {
    return { ok: false, reason: "this machine has no owner — enrol it again from the machine" };
  }
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

export function offersFor(
  reported: RepoReport[],
  projects: OfferableProject[],
  reachable: string[] | null
): ProjectOffer[] {
  const out: ProjectOffer[] = [];
  for (const project of projects) {
    if (!project.worker?.enabled) continue;
    if (!canServe(reachable, String(project._id))) continue;
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

export function catalogueFor(
  reported: RepoReport[],
  projects: OfferableProject[],
  reachable: string[] | null,
  desired: string[] | undefined
): ProjectCatalogueEntry[] {
  const wanted = desired ? new Set(desired.map(String)) : null;
  const out: ProjectCatalogueEntry[] = [];

  for (const project of projects) {
    const id = String(project._id);
    if (!canServe(reachable, id)) continue;

    const repositoryUrl = projectRepositoryUrl(project);
    const servedHere = !!matchRepo(project, reported);

    out.push({
      project: id,
      key: project.key ?? "",
      name: project.name ?? "",
      repositoryUrl,
      available: !!repositoryUrl,
      workersEnabled: !!project.worker?.enabled,
      servedHere,
      wanted: wanted ? wanted.has(id) : servedHere,
    });
  }

  return out;
}

export interface ProjectCatalogueEntry {
  project: string;
  key: string;
  name: string;
  repositoryUrl: string;
  available: boolean;
  workersEnabled: boolean;
  servedHere: boolean;
  wanted: boolean;
}

export interface ProjectOffer {
  project: string;
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
  return Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER;
}

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
    const otherWins = theirs < mine || (theirs === mine && String(other._id) < myId);
    if (!otherWins) continue;

    const taken = new Set((other.repos ?? []).map((r) => r.path));
    for (const repo of worker.repos ?? []) {
      if (taken.has(repo.path)) lost.set(repo.path, other.name);
    }
  }
  return lost;
}

export function usableRepos(
  worker: CheckoutClaimant,
  others: CheckoutClaimant[],
  now = new Date()
): RepoReport[] {
  const lost = lostCheckouts(worker, others, now);
  return (worker.repos ?? []).filter((r) => !lost.has(r.path));
}

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
  owner?: string;
  ownerId?: string;
}): Promise<{ worker: IWorker; credential: string }> {
  await connectDB();
  const credential = `cpw_${crypto.randomBytes(32).toString("hex")}`;
  const { owner, ownerId, ...fields } = input;

  const existing = await Worker.findOne({ name: fields.name, host: fields.host })
    .select("owner")
    .lean();
  const adopted = !!existing && !existing.owner && !!ownerId;

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

function apiOwner(owner: IWorker["owner"]): ApiUserSummary | null {
  const user = owner as IUser | null | undefined;
  if (!user || !user.username) return null;
  return { _id: String(user._id), username: user.username, fullName: user.fullName };
}

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
