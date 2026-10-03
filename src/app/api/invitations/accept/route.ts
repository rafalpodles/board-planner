import { NextResponse } from "next/server";
import { passwordSignInEnabled, passwordSignInOff } from "@/lib/password-sign-in";
import bcrypt from "bcryptjs";
import { readJsonBody } from "@/lib/request-body";
import { connectDB } from "@/lib/db";
import { getClientIp, PASSWORD_COST_FACTOR } from "@/lib/auth";
import { anonymousMultiplier, isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import { provenanceRefusal } from "@/lib/session";
import { checkNewAccount } from "@/lib/new-account";
import { claimInvitation } from "@/lib/invitations";
import { INVITATION_REFUSALS } from "@/lib/invitation-refusals";
import { completeAcceptance } from "@/lib/invitation-acceptance";

const ATTEMPTS_PER_SOURCE = 20;

export async function POST(request: Request) {
  if (!passwordSignInEnabled()) return passwordSignInOff();
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  const clientIp = getClientIp(request);
  const throttleKey = sourceKey(clientIp ?? "-", "invitation-use");
  if (await isRateLimited(throttleKey, anonymousMultiplier(clientIp, ATTEMPTS_PER_SOURCE))) {
    return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  }
  await recordFailedAttempt(throttleKey);

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
  const hashed = await bcrypt.hash(password, PASSWORD_COST_FACTOR);

  const claimed = await claimInvitation(token);
  if (!claimed.ok) {
    return NextResponse.json({ error: INVITATION_REFUSALS[claimed.reason] }, { status: 400 });
  }
  const invitation = claimed.invitation;

  return completeAcceptance(invitation, { username, fullName, passwordHash: hashed }, request, clientIp);
}
