import { NextResponse } from "next/server";
import { forgetCookie, signInRoute } from "@/lib/platform-sign-in-route";
import { provenanceRefusal } from "@/lib/session";

export const DELETE = signInRoute(async (request) => {
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;
  const response = NextResponse.json({ forgotten: true });
  response.headers.append("Set-Cookie", forgetCookie());
  return response;
});
