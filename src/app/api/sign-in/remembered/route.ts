import { NextResponse } from "next/server";
import { servedOrganisationById } from "@/lib/platform-sign-in";
import { forgetCookie, refusedOffThePlatform, rememberedOrganisation } from "@/lib/platform-sign-in-route";
import { provenanceRefusal } from "@/lib/session";

export async function GET(request: Request) {
  const offPlatform = await refusedOffThePlatform(request);
  if (offPlatform) return offPlatform;
  const organisation = await servedOrganisationById(rememberedOrganisation(request));
  return NextResponse.json({ organisation: organisation ? { name: organisation.name, origin: organisation.origin } : null });
}

export async function DELETE(request: Request) {
  const offPlatform = await refusedOffThePlatform(request);
  if (offPlatform) return offPlatform;
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;
  const response = NextResponse.json({ forgotten: true });
  response.headers.append("Set-Cookie", forgetCookie());
  return response;
}
