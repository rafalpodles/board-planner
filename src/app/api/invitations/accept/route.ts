import { hostNotFound } from "@/lib/middleware";
import { NextResponse } from "next/server";
import { passwordSignInEnabled, passwordSignInOff } from "@/lib/password-sign-in";
import bcrypt from "bcryptjs";
import { readJsonBody } from "@/lib/request-body";
import { connectDB } from "@/lib/db";
import { getClientIp, PASSWORD_COST_FACTOR } from "@/lib/auth";
import { isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import { provenanceRefusal } from "@/lib/session";
import { checkNewAccount } from "@/lib/new-account";
import { claimInvitation, findInvitationByToken } from "@/lib/invitations";
import { INVITATION_REFUSALS } from "@/lib/invitation-refusals";
import { completeAcceptance } from "@/lib/invitation-acceptance";
import { scopedForRequest } from "@/lib/db-scope";

const ATTEMPTS_PER_SOURCE = 20;

export async function POST(request: Request) {
  const db = await scopedForRequest(request);
  if (!db) return hostNotFound();
  if (!passwordSignInEnabled()) return passwordSignInOff();
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  const clientIp = getClientIp(request);
  // The link is the secret, and a bucket shared by every caller with no address would only let
  // anybody stop every invitation being used (BP-840)
  const throttleKey = clientIp ? sourceKey(clientIp, "invitation-use") : null;
  if (throttleKey) {
    if (await isRateLimited(throttleKey, ATTEMPTS_PER_SOURCE)) {
      return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
    }
    await recordFailedAttempt(throttleKey);
  }

  const read = await readJsonBody<{
    token?: unknown;
    username?: unknown;
    fullName?: unknown;
    password?: unknown;
  }>(request);
  if (!read.ok) return read.response;
  const { token, ...fields } = read.value;
  if (typeof token !== "string" || !token) {
    return NextResponse.json({ error: INVITATION_REFUSALS.unknown }, { status: 400 });
  }
  // Checked before the link is spent, so a refused username does not cost the invitee their link
  const checked = checkNewAccount({ ...fields, email: undefined });
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  const { username, fullName, password } = checked.value;

  await connectDB();
  // Read first, so the hash below costs only somebody holding a live link: with no client address
  // nothing else bounds how often this runs (BP-840)
  const found = await findInvitationByToken(db, token);
  if (!found.ok) return NextResponse.json({ error: INVITATION_REFUSALS[found.reason] }, { status: 400 });
  const hashed = await bcrypt.hash(password, PASSWORD_COST_FACTOR);

  const claimed = await claimInvitation(db, token);
  if (!claimed.ok) {
    return NextResponse.json({ error: INVITATION_REFUSALS[claimed.reason] }, { status: 400 });
  }
  const invitation = claimed.invitation;

  return completeAcceptance(db, invitation, { username, fullName, passwordHash: hashed }, request, clientIp);
}
