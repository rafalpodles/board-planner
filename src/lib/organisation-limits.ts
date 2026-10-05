import { NextResponse } from "next/server";
import type { Types } from "mongoose";
import { countInWindow } from "./rate-limit";
import { organisationDomain } from "./organisation-host";
import { ORGANISATION_LIMIT_HEADER } from "./organisation-limit-header";

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

export function organisationRequestsKey(organisation: Types.ObjectId): string {
  return `organisation-requests:${organisation.toHexString()}`;
}

export async function requestLimitRefusal(organisation: Types.ObjectId): Promise<NextResponse | null> {
  const limit = requestsPerMinute();
  if (!limit) return null;
  const { count, resetAt } = await countInWindow(organisationRequestsKey(organisation), MINUTE_MS);
  if (count <= limit) return null;
  const seconds = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
  return NextResponse.json(
    {
      error: `This organisation has made more than ${limit} requests in a minute. Try again in ${seconds} s.`,
      limit,
      resetAt: resetAt.toISOString(),
    },
    { status: 429, headers: { "Retry-After": String(seconds), [ORGANISATION_LIMIT_HEADER]: "requests" } }
  );
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
