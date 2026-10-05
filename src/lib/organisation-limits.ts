import { NextResponse } from "next/server";
import type { Types } from "mongoose";
import { countInWindow } from "./rate-limit";
import { organisationDomain } from "./organisation-host";
import { ORGANISATION_LIMIT_HEADER, type RequestLimitScope } from "./organisation-limit-header";

const MINUTE_MS = 60_000;
const MB = 1024 * 1024;

export const CLOUD_REQUESTS_PER_MINUTE = 6000;
export const CLOUD_STORAGE_MB = 5120;

const warned = new Set<string>();

// 0 is off. Set, the value holds on any instance; unset, only organisations on ORGANISATION_DOMAIN get one
function configuredLimit(name: string, cloudDefault: number): number {
  const fallback = organisationDomain() ? cloudDefault : 0;
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= 0) return value;
  if (!warned.has(name)) {
    warned.add(name);
    console.warn(`${name}="${raw}" is not a whole number of 0 or more; using ${fallback}`);
  }
  return fallback;
}

export function requestsPerMinute(): number {
  return configuredLimit("ORGANISATION_REQUESTS_PER_MINUTE", CLOUD_REQUESTS_PER_MINUTE);
}

export function storageLimitBytes(): number {
  return configuredLimit("ORGANISATION_STORAGE_MB", CLOUD_STORAGE_MB) * MB;
}

// One account or machine may spend at most this share of its organisation's minute, so a runaway
// credential is cut off before it can starve everybody else
export const PRINCIPAL_SHARE = 0.5;

export interface RequestPrincipal {
  id: string;
  // An administrator at the keyboard must still be able to stop whoever is spending the minute
  interactiveAdmin?: boolean;
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

function megabytes(bytes: number): string {
  return `${Math.ceil(bytes / MB)} MB`;
}

export function storageLimitRefusal(storedBytes: number, incomingBytes: number): NextResponse | null {
  const limit = storageLimitBytes();
  if (!limit || storedBytes + incomingBytes <= limit) return null;
  return NextResponse.json(
    {
      error: `This organisation has used ${megabytes(storedBytes)} of its ${megabytes(limit)} of file storage, so no more files can be uploaded.`,
      limit,
      stored: storedBytes,
    },
    { status: 413 }
  );
}
