import { NextResponse } from "next/server";
import {
  clearSessionCookies,
  provenanceRefusal,
  revokeSession,
  sessionCookieTokens,
} from "@/lib/session";

export async function POST(request: Request) {
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  // Both names: under COOKIE_ALLOW_INSECURE=auto a browser can hold a prefixed session from an
  // https sign-in and a plain one from an http sign-in, and each is a row of its own. Revoking
  // only the one that reads first left the other alive for its full lifetime (BP-773 review).
  for (const token of sessionCookieTokens(request.headers.get("cookie"))) {
    await revokeSession(token);
  }

  const response = NextResponse.json({ ok: true });
  for (const cookie of clearSessionCookies()) {
    response.headers.append("Set-Cookie", cookie);
  }

  return response;
}
