import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/request-body";
import { getClientIp, verifyCredentials } from "@/lib/auth";
import { isDatabaseUnreachable } from "@/lib/db-errors";
import { databaseUnavailable } from "@/lib/middleware";
import { lockoutKey, sourceKey, withLockout } from "@/lib/rate-limit";
import {
  buildSessionCookie,
  createSession,
  legacySessionCookies,
  provenanceRefusal,
} from "@/lib/session";

export async function POST(request: Request) {
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  const read = await readJsonBody<{ username?: unknown; password?: unknown }>(request);
  if (!read.ok) return read.response;
  const body = read.value;

  const { username, password } = body;
  if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
    return NextResponse.json(
      { error: "username and password are required" },
      { status: 400 }
    );
  }

  const clientIp = getClientIp(request);
  let lockedOut: boolean;
  let user: Awaited<ReturnType<typeof verifyCredentials>>;
  try {
    ({ lockedOut, result: user } = await withLockout(
      lockoutKey(clientIp ?? "-", username),
      () => verifyCredentials(username, password),
      clientIp ? sourceKey(clientIp) : undefined
    ));
  } catch (e) {
    if (isDatabaseUnreachable(e)) return databaseUnavailable();
    throw e;
  }

  if (lockedOut) {
    return NextResponse.json(
      { error: "Too many failed attempts. Try again later." },
      { status: 429 }
    );
  }

  if (!user) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const { token, absoluteExpiresAt } = await createSession({
    userId: user._id,
    userAgent: request.headers.get("user-agent"),
    ip: clientIp,
  });

  const response = NextResponse.json({
    _id: user._id,
    username: user.username,
    fullName: user.fullName,
    email: user.email || "",
    emailNotifications: user.emailNotifications || false,
    collapseEmptyColumns: user.collapseEmptyColumns ?? true,
    role: user.role || "member",
    createdAt: user.createdAt,
  });

  response.headers.append("Set-Cookie", buildSessionCookie(token, absoluteExpiresAt));
  for (const cookie of legacySessionCookies()) {
    response.headers.append("Set-Cookie", cookie);
  }

  return response;
}
