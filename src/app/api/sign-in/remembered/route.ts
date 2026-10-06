import { NextResponse } from "next/server";
import { servedOrganisationById } from "@/lib/platform-sign-in";
import { forgetCookie, rememberedOrganisation, signInRoute } from "@/lib/platform-sign-in-route";
import { provenanceRefusal } from "@/lib/session";

export const GET = signInRoute(async (request) => {
  const organisation = await servedOrganisationById(rememberedOrganisation(request));
  return NextResponse.json({ organisation: organisation ? { name: organisation.name, origin: organisation.origin } : null });
});

export const DELETE = signInRoute(async (request) => {
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;
  const response = NextResponse.json({ forgotten: true });
  response.headers.append("Set-Cookie", forgetCookie());
  return response;
});
