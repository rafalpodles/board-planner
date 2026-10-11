import { NextResponse } from "next/server";
import type { Types } from "mongoose";
import type { IUser, IWorker } from "@/types";
import { countInLiveWindow, countInWindow } from "./rate-limit";
import type { ScopedDb } from "./db-scope";
import { organisationUploads } from "./upload-ownership";
import { organisationDomain } from "./organisation-host";
import { getOrganisation } from "./organisation";
import type { Plan } from "./entitlements";
import { FREE_STORAGE_MB, PAID_STORAGE_MB, formatStorage } from "./storage-size";
import { ORGANISATION_LIMIT_HEADER, type RequestLimitScope } from "./organisation-limit-header";

const MINUTE_MS = 60_000;
const MB = 1024 * 1024;

export const CLOUD_REQUESTS_PER_MINUTE = 6000;

const warned = new Set<string>();

function explicitLimit(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= 0) return value;
  if (!warned.has(name)) {
    warned.add(name);
    console.warn(`${name}="${raw}" is not a whole number of 0 or more; ignoring it`);
  }
  return null;
}

// 0 is off. Set, the value holds on any instance; unset, only organisations on ORGANISATION_DOMAIN get one
function configuredLimit(name: string, cloudDefault: number): number {
  return explicitLimit(name) ?? (organisationDomain() ? cloudDefault : 0);
}

export function requestsPerMinute(): number {
  return configuredLimit("ORGANISATION_REQUESTS_PER_MINUTE", CLOUD_REQUESTS_PER_MINUTE);
}

export interface StorageLimit {
  bytes: number;
  upgradeLifts: boolean;
}

export function storageLimitFor(plan: Plan): StorageLimit {
  const explicit = explicitLimit("ORGANISATION_STORAGE_MB");
  const bytes = configuredLimit("ORGANISATION_STORAGE_MB", plan === "pro" ? PAID_STORAGE_MB : FREE_STORAGE_MB) * MB;
  return { bytes, upgradeLifts: explicit === null && plan === "free" && organisationDomain() !== null && bytes > 0 };
}

export async function storageLimitOf(db: ScopedDb): Promise<StorageLimit> {
  if (explicitLimit("ORGANISATION_STORAGE_MB") !== null || organisationDomain() === null) return storageLimitFor("free");
  return storageLimitFor((await getOrganisation(db.organisation)).entitlements.plan);
}

// One account or machine may spend at most this share of its organisation's minute, so a runaway
// credential is cut off before it can starve everybody else
export const PRINCIPAL_SHARE = 0.5;

export interface RequestPrincipal {
  id: string;
  // An administrator at the keyboard must still be able to stop whoever is spending the minute
  interactiveAdmin?: boolean;
}

export function asPrincipal(user: IUser): RequestPrincipal {
  return { id: String(user._id), interactiveAdmin: user.role === "admin" && !user.viaMachineCredential };
}

// A machine spends its owner's share: enrolling more machines must not buy a person more of the minute
export function machinePrincipal(worker: Pick<IWorker, "_id" | "owner">): RequestPrincipal {
  // An ObjectId's _id is itself, so this reads a populated owner and a bare id alike
  return { id: String(worker.owner?._id ?? worker._id) };
}

export function organisationRequestsKey(organisation: Types.ObjectId): string {
  return `organisation-requests:${organisation.toHexString()}`;
}

export function principalRequestsKey(principal: string): string {
  return `principal-requests:${principal}`;
}

function tooManyRequests(scope: RequestLimitScope, limit: number, resetAt: Date): NextResponse {
  const seconds = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
  const who = scope === "organisation" ? "This organisation has" : "You have";
  return NextResponse.json(
    { error: `${who} made more than ${limit} requests in a minute. Try again in ${seconds} s.`, limit, resetAt: resetAt.toISOString() },
    { status: 429, headers: { "Retry-After": String(seconds), [ORGANISATION_LIMIT_HEADER]: scope } }
  );
}

export async function requestLimitRefusal(
  organisation: Types.ObjectId,
  principal: RequestPrincipal
): Promise<NextResponse | null> {
  const limit = requestsPerMinute();
  if (!limit) return null;
  const share = Math.max(1, Math.floor(limit * PRINCIPAL_SHARE));
  const own = await countInWindow(principalRequestsKey(principal.id), MINUTE_MS);
  if (own.count > share) return tooManyRequests("principal", share, own.resetAt);
  if (principal.interactiveAdmin) return null;
  const all = await countInWindow(organisationRequestsKey(organisation), MINUTE_MS);
  if (all.count > limit) return tooManyRequests("organisation", limit, all.resetAt);
  return null;
}

export function storageLimitRefusal(storedBytes: number, incomingBytes: number, { bytes, upgradeLifts }: StorageLimit): NextResponse | null {
  if (!bytes || storedBytes + incomingBytes <= bytes) return null;
  const used = `This organisation has used ${formatStorage(storedBytes)} of its ${formatStorage(bytes)} of file storage${upgradeLifts ? " on the Free plan" : ""}, so no more files can be uploaded.`;
  return NextResponse.json(
    {
      error: upgradeLifts ? `${used} Upgrade to Pro for ${formatStorage(PAID_STORAGE_MB * MB)}.` : used,
      ...(upgradeLifts ? { feature: "storage.limit", plan: "free" } : {}),
      limit: bytes,
      stored: storedBytes,
    },
    { status: 413 }
  );
}

export async function organisationUsage(db: ScopedDb) {
  const [requestsThisMinute, storedBytes, storage] = await Promise.all([
    countInLiveWindow(organisationRequestsKey(db.organisation)),
    organisationUploads(db)?.bytesStored() ?? 0,
    storageLimitOf(db),
  ]);
  return { requestsThisMinute, requestsPerMinute: requestsPerMinute(), storedBytes, storageLimitBytes: storage.bytes };
}
