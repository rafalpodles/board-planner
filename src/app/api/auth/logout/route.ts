import { NextResponse } from "next/server";
import {
  clearSessionCookies,
  provenanceRefusal,
  readSessionCookie,
  revokeSession,
} from "@/lib/session";

export async function POST(request: Request) {
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  const token = readSessionCookie(request.headers.get("cookie"));
  if (token) {
    await revokeSession(token);
  }

  const response = NextResponse.json({ ok: true });
  for (const cookie of clearSessionCookies()) {
    response.headers.append("Set-Cookie", cookie);
  }

  return response;
}
