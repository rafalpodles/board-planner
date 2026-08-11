import { NextResponse } from "next/server";
import { getClientIp, verifyCredentials } from "@/lib/auth";
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

  let body: { username?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { username, password } = body;
  if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
    return NextResponse.json(
      { error: "username and password are required" },
      { status: 400 }
    );
  }

  const clientIp = getClientIp(request);
  const { lockedOut, result: user } = await withLockout(
    lockoutKey(clientIp ?? "-", username),
    () => verifyCredentials(username, password),
    clientIp ? sourceKey(clientIp) : undefined
  );

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
