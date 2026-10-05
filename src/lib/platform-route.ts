import { NextResponse } from "next/server";
import type { Types } from "mongoose";
import { connectDB } from "./db";
import { hostNotFound } from "./middleware";
import { organisationOfRequest } from "./organisation-host";
import { verifyPlatformRequest } from "./platform-request";
import { readBodyBytes } from "./request-body";
import { PlatformAuditLog, type PlatformAuditAction } from "@/models/platformAuditLog";

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

type PlatformHandler<P> = (
  request: Request,
  context: { keyId: string; body: Uint8Array; params: P }
) => Promise<Response>;

/**
 * The platform operator's way in: the licence service, signing each request with a key listed in
 * PLATFORM_REQUEST_KEYS. It has no account here, so no session, token or organisation admin reaches
 * these routes, and they answer only on the platform host.
 */
export function withPlatformRequest<P = Record<string, string>>(
  handler: PlatformHandler<P>,
  { maxBodyBytes = DEFAULT_MAX_BODY_BYTES }: { maxBodyBytes?: number } = {}
) {
  return async (request: Request, context: { params: Promise<P> }) => {
    if ((await organisationOfRequest(request)).kind !== "platform") return hostNotFound();

    const read = await readBodyBytes(request, maxBodyBytes);
    if (!read.ok) return read.response;

    await connectDB();
    const verdict = await verifyPlatformRequest(request, read.value);
    if (!verdict.ok) {
      console.warn(`Platform request refused: ${verdict.reason} (key ${verdict.keyId ?? "none"})`);
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return handler(request, { keyId: verdict.keyId, body: read.value, params: await context.params });
  };
}

export async function logPlatformAudit(entry: {
  action: PlatformAuditAction;
  keyId: string;
  subject?: Types.ObjectId | string | null;
  detail?: string;
}): Promise<void> {
  try {
    await PlatformAuditLog.create({ ...entry, subject: entry.subject ?? null, detail: entry.detail ?? "" });
  } catch (error) {
    console.error("Failed to write the platform audit log:", error);
  }
}
