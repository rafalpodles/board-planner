import { NextResponse } from "next/server";
import { getClientIp } from "@/lib/client-ip";
import { verifyCredentials } from "@/lib/auth";
import { passwordSignInEnabled, passwordSignInOff } from "@/lib/password-sign-in";
import { accountByEmail, endSignIn, issueHandoff, scopedToOrganisation, servedOrganisationById } from "@/lib/platform-sign-in";
import { clearedSignInCookie, provenEmail, rememberCookie, signInBinder, startAgain, signInRoute } from "@/lib/platform-sign-in-route";
import { lockoutKey, sourceKey, withLockout } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/request-body";
import { provenanceRefusal } from "@/lib/session";

const invalid = () => NextResponse.json({ error: "Invalid credentials" }, { status: 401 });

export const POST = signInRoute(async (request) => {
  if (!passwordSignInEnabled()) return passwordSignInOff();
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  const email = await provenEmail(request);
  if (!email) return startAgain();

  const read = await readJsonBody<{ organisation?: unknown; password?: unknown }>(request);
  if (!read.ok) return read.response;
  const { password } = read.value;
  if (typeof password !== "string" || !password) return NextResponse.json({ error: "Enter your password" }, { status: 400 });

  const organisation = await servedOrganisationById(read.value.organisation);
  if (!organisation) return invalid();
  const db = scopedToOrganisation(organisation);
  const account = await accountByEmail(db, email);
  const username = account?.username ?? email;

  const clientIp = getClientIp(request);
  const { lockedOut, result: user } = await withLockout(
    lockoutKey(db.organisation, clientIp ?? "-", username),
    () => verifyCredentials(db, username, password),
    clientIp ? sourceKey(clientIp) : undefined
  );
  if (lockedOut) return NextResponse.json({ error: "Too many failed attempts. Try again later." }, { status: 429 });
  if (!user || !account || !user._id.equals(account._id)) return invalid();

  const code = await issueHandoff(db, user._id);
  await endSignIn(signInBinder(request));
  const response = NextResponse.json({ location: `${organisation.origin}/api/auth/handoff?code=${encodeURIComponent(code)}` });
  response.headers.append("Set-Cookie", rememberCookie(organisation.id));
  response.headers.append("Set-Cookie", clearedSignInCookie());
  return response;
});
