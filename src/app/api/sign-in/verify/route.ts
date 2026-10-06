import { NextResponse } from "next/server";
import { passwordSignInEnabled } from "@/lib/password-sign-in";
import { organisationDomain } from "@/lib/organisation-host";
import { getClientIp } from "@/lib/client-ip";
import { organisationsFor, verifiedEmail, verifySignInCode } from "@/lib/platform-sign-in";
import { signInBinder, startAgain, signInRoute } from "@/lib/platform-sign-in-route";
import { isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/request-body";
import { provenanceRefusal } from "@/lib/session";

const WRONG_CODES_PER_SOURCE = 30;

export const POST = signInRoute(async (request) => {
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  const binder = signInBinder(request);
  if (!binder) return startAgain();

  const clientIp = getClientIp(request);
  const perSource = clientIp ? sourceKey(clientIp, "platform-sign-in-code") : null;
  if (perSource && (await isRateLimited(perSource, WRONG_CODES_PER_SOURCE))) {
    return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  }

  const read = await readJsonBody<{ code?: unknown }>(request);
  if (!read.ok) return read.response;
  const code = typeof read.value.code === "string" ? read.value.code.trim() : "";
  if (!/^\d{6}$/.test(code)) return NextResponse.json({ error: "Enter the six digits from the e-mail" }, { status: 400 });

  const verdict = await verifySignInCode(binder, code);
  if (verdict === "expired") return startAgain();
  if (verdict === "wrong") {
    if (perSource) await recordFailedAttempt(perSource);
    return NextResponse.json({ error: "That code is not right. Check the e-mail and try again." }, { status: 400 });
  }

  const email = await verifiedEmail(binder);
  if (!email) return startAgain();
  return NextResponse.json({ email, organisations: await organisationsFor(email), passwordSignIn: passwordSignInEnabled(), domain: organisationDomain() });
});
