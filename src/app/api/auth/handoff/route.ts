import { NextResponse } from "next/server";
import { getClientIp } from "@/lib/client-ip";
import { isDatabaseUnreachable } from "@/lib/db-errors";
import { scopedForRequest } from "@/lib/db-scope";
import { databaseUnavailable, hostNotFound } from "@/lib/middleware";
import { organisationDomain, originFor } from "@/lib/organisation-host";
import { spendHandoff } from "@/lib/platform-sign-in";
import { isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import { buildSessionCookie, createSession, legacySessionCookies } from "@/lib/session";

const FAILED_HANDOFFS_PER_SOURCE = 30;

function redirectTo(origin: string, path: string, cookies: string[] = []) {
  const response = NextResponse.redirect(new URL(path, origin), 303);
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

// The legitimate hop is a navigation from the platform host, a sibling; a page elsewhere must not plant somebody else's session
function arrivedFromThisSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  const mode = request.headers.get("sec-fetch-mode");
  if (site !== null && !["same-site", "same-origin", "none"].includes(site)) return false;
  return mode === null || mode === "navigate";
}

export async function GET(request: Request) {
  try {
    return await handOff(request);
  } catch (error) {
    if (isDatabaseUnreachable(error)) return databaseUnavailable();
    throw error;
  }
}

async function handOff(request: Request) {
  if (!organisationDomain()) return hostNotFound();
  const db = await scopedForRequest(request);
  if (!db) return hostNotFound();
  const origin = await originFor(db);
  if (!origin) return NextResponse.json({ error: "This organisation has no address" }, { status: 500 });

  // With no address there is no source, and one shared bucket would let anybody stop every handoff;
  // the code is 32 random bytes, which no budget is needed to protect
  const clientIp = getClientIp(request);
  const perSource = clientIp ? sourceKey(clientIp, "handoff") : null;
  if (perSource && (await isRateLimited(perSource, FAILED_HANDOFFS_PER_SOURCE))) {
    return redirectTo(origin, "/login?handoff=throttled");
  }

  if (!arrivedFromThisSite(request)) return redirectTo(origin, "/login?handoff=expired");

  const code = new URL(request.url).searchParams.get("code") ?? "";
  const userId = code ? await spendHandoff(db, code) : null;
  const user = userId
    ? await db.User.findOne({ _id: userId, kind: { $ne: "machine" }, deactivatedAt: null }).select("_id").lean()
    : null;
  if (!user) {
    if (perSource) await recordFailedAttempt(perSource);
    return redirectTo(origin, "/login?handoff=expired");
  }

  const { token, absoluteExpiresAt } = await createSession({
    userId: user._id,
    organisation: db.organisation,
    userAgent: request.headers.get("user-agent"),
    ip: clientIp,
  });
  return redirectTo(origin, "/projects", [buildSessionCookie(token, absoluteExpiresAt, request), ...legacySessionCookies(request)]);
}
