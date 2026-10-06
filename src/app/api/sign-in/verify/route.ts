import { NextResponse } from "next/server";
import { getClientIp } from "@/lib/client-ip";
import { organisationsFor, verifiedEmail, verifySignInCode } from "@/lib/platform-sign-in";
import { refusedOffThePlatform, signInBinder, startAgain } from "@/lib/platform-sign-in-route";
import { anonymousMultiplier, isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/request-body";
import { provenanceRefusal } from "@/lib/session";

const WRONG_CODES_PER_SOURCE = 30;

export async function POST(request: Request) {
  const offPlatform = await refusedOffThePlatform(request);
  if (offPlatform) return offPlatform;
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  const binder = signInBinder(request);
  if (!binder) return startAgain();

  const clientIp = getClientIp(request);
  const perSource = sourceKey(clientIp ?? "-", "platform-sign-in-code");
  if (await isRateLimited(perSource, anonymousMultiplier(clientIp, WRONG_CODES_PER_SOURCE))) {
    return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  }

  const read = await readJsonBody<{ code?: unknown }>(request);
  if (!read.ok) return read.response;
  const code = typeof read.value.code === "string" ? read.value.code.trim() : "";
  if (!/^\d{6}$/.test(code)) return NextResponse.json({ error: "Enter the six digits from the e-mail" }, { status: 400 });

  const verdict = await verifySignInCode(binder, code);
  if (verdict === "expired") return startAgain();
  if (verdict === "wrong") {
    await recordFailedAttempt(perSource);
    return NextResponse.json({ error: "That code is not right. Check the e-mail and try again." }, { status: 400 });
  }

  const email = await verifiedEmail(binder);
  if (!email) return startAgain();
  return NextResponse.json({ email, organisations: await organisationsFor(email) });
}
