import { NextResponse } from "next/server";
import { getClientIp } from "@/lib/client-ip";
import { connectDB } from "@/lib/db";
import { scopedForRequest } from "@/lib/db-scope";
import { hostNotFound } from "@/lib/middleware";
import { originFor } from "@/lib/organisation-host";
import { spendHandoff } from "@/lib/platform-sign-in";
import { anonymousMultiplier, isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import { buildSessionCookie, createSession, legacySessionCookies } from "@/lib/session";

const FAILED_HANDOFFS_PER_SOURCE = 30;

function redirectTo(origin: string, path: string, cookies: string[] = []) {
  const response = NextResponse.redirect(new URL(path, origin), 303);
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

export async function GET(request: Request) {
  const db = await scopedForRequest(request);
  if (!db) return hostNotFound();
  const origin = await originFor(db);
  if (!origin) return NextResponse.json({ error: "This organisation has no address" }, { status: 500 });

  const clientIp = getClientIp(request);
  const perSource = sourceKey(clientIp ?? "-", "handoff");
  if (await isRateLimited(perSource, anonymousMultiplier(clientIp, FAILED_HANDOFFS_PER_SOURCE))) {
    return redirectTo(origin, "/login?handoff=throttled");
  }

  const code = new URL(request.url).searchParams.get("code") ?? "";
  const userId = code ? await spendHandoff(db, code) : null;
  await connectDB();
  const user = userId
    ? await db.User.findOne({ _id: userId, kind: { $ne: "machine" }, deactivatedAt: null }).select("_id").lean()
    : null;
  if (!user) {
    await recordFailedAttempt(perSource);
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
