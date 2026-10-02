import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { readJsonBody } from "@/lib/request-body";
import { connectDB } from "@/lib/db";
import { getClientIp, PASSWORD_COST_FACTOR } from "@/lib/auth";
import { anonymousMultiplier, isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import { buildSessionCookie, createSession, legacySessionCookies, provenanceRefusal } from "@/lib/session";
import { checkNewAccount } from "@/lib/new-account";
import { duplicateKeyField } from "@/lib/mongo-errors";
import {
  claimInvitation,
  markInvitationRevoked,
  recordAcceptance,
  releaseInvitation,
} from "@/lib/invitations";
import { authorityAtAcceptance } from "@/lib/invitation-authority";
import { INVITATION_REFUSALS } from "@/lib/invitation-refusals";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { logProjectAudit } from "@/lib/projectAudit";
import { Grant } from "@/models/grant";
import { User } from "@/models/user";

const ATTEMPTS_PER_SOURCE = 20;

export async function POST(request: Request) {
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

  const authority = await authorityAtAcceptance(invitation);
  if (!authority) {
    await markInvitationRevoked(invitation._id);
    return NextResponse.json({ error: INVITATION_REFUSALS.revoked }, { status: 400 });
  }

  let user;
  try {
    user = await User.create({
      username,
      password: hashed,
      fullName,
      email: invitation.email,
      role: authority.role,
    });
  } catch (err) {
    await releaseInvitation(invitation._id).catch(() => {});
    const conflict = duplicateKeyField(err);
    if (conflict === "email") {
      return NextResponse.json(
        { error: "That address already has an account. Sign in instead." },
        { status: 409 }
      );
    }
    if (conflict) {
      return NextResponse.json({ error: "Username already exists" }, { status: 409 });
    }
    throw err;
  }

  await recordAcceptance(invitation._id, user._id);

  for (const board of authority.boards) {
    try {
      await Grant.findOneAndUpdate(
        { subject: user._id, objectType: "project", object: board.project },
        { $set: { relation: board.relation }, $setOnInsert: { createdBy: board.addedBy } },
        { upsert: true }
      );
      void logProjectAudit(
        String(board.project),
        String(board.addedBy),
        "member_added",
        `${user.username}: no access → ${board.relation}`
      );
    } catch (err) {
      console.error("Failed to grant an invited board:", err);
    }
  }

  void logInstanceAudit({
    action: "invitation_accepted",
    user: user._id,
    actorUsername: user.username,
    target: invitation.email,
    detail: `as ${authority.role === "admin" ? "an administrator" : "a member"}, account ${user.username}`,
  });

  const { token: sessionToken, absoluteExpiresAt } = await createSession({
    userId: user._id,
    userAgent: request.headers.get("user-agent"),
    ip: clientIp,
  });

  const response = NextResponse.json(
    {
      username: user.username,
      landing: authority.boards.length ? String(authority.boards[0].project) : null,
    },
    { status: 201 }
  );
  response.headers.append("Set-Cookie", buildSessionCookie(sessionToken, absoluteExpiresAt, request));
  for (const cookie of legacySessionCookies(request)) {
    response.headers.append("Set-Cookie", cookie);
  }
  return response;
}
