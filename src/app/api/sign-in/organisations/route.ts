import { NextResponse } from "next/server";
import { organisationsFor } from "@/lib/platform-sign-in";
import { provenEmail, refusedOffThePlatform, startAgain } from "@/lib/platform-sign-in-route";

export async function GET(request: Request) {
  const offPlatform = await refusedOffThePlatform(request);
  if (offPlatform) return offPlatform;
  const email = await provenEmail(request);
  if (!email) return startAgain();
  return NextResponse.json({ email, organisations: await organisationsFor(email) });
}
