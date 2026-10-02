import { NextResponse } from "next/server";
import { buildSessionCookie, createSession, legacySessionCookies } from "@/lib/session";
import { duplicateKeyField } from "@/lib/mongo-errors";
import {
  recordAcceptance,
  releaseInvitation,
  revokeClaimedInvitation,
  revokePendingInvitationsFor,
} from "@/lib/invitations";
import { authorityAtAcceptance } from "@/lib/invitation-authority";
import { INVITATION_REFUSALS } from "@/lib/invitation-refusals";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { logProjectAudit } from "@/lib/projectAudit";
import { Grant } from "@/models/grant";
import { Identity } from "@/models/identity";
import { User } from "@/models/user";
import { IInvitation } from "@/types";

export interface NewAccount {
  username: string;
  fullName: string;
  /** Null for an account that signs in through an identity provider only. */
  passwordHash: string | null;
  identity?: { provider: string; subject: string; email: string };
}

/**
 * Everything after the link was claimed: what it may still grant, the account, the identity it
 * signs in with, the boards, and the session. Shared by the password and the provider paths so
 * the two cannot drift apart on what an invitation grants.
 */
export async function completeAcceptance(
  invitation: IInvitation,
  account: NewAccount,
  request: Request,
  clientIp: string | null
): Promise<NextResponse> {
  const authority = await authorityAtAcceptance(invitation);
  if (!authority) {
    await revokeClaimedInvitation(invitation._id);
    return NextResponse.json({ error: INVITATION_REFUSALS.revoked }, { status: 400 });
  }

  let user;
  try {
    user = await User.create({
      username: account.username,
      ...(account.passwordHash ? { password: account.passwordHash } : {}),
      fullName: account.fullName,
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

  let stillHeld = true;
  try {
    stillHeld = await recordAcceptance(invitation._id, user._id);
  } catch (err) {
    // The account exists either way, so its boards are still granted below
    console.error("Failed to record an invitation's acceptance:", err);
  }
  if (!stillHeld) {
    await User.deleteOne({ _id: user._id }).catch(() => {});
    return NextResponse.json({ error: INVITATION_REFUSALS.revoked }, { status: 400 });
  }
  if (account.identity) {
    try {
      await Identity.create({ user: user._id, ...account.identity, lastUsedAt: new Date() });
    } catch (err) {
      // The identity was linked to another account in the meantime: this one could never sign in
      await User.deleteOne({ _id: user._id }).catch(() => {});
      await releaseInvitation(invitation._id).catch(() => {});
      if (duplicateKeyField(err)) {
        return NextResponse.json(
          { error: "That sign-in is already linked to another account." },
          { status: 409 }
        );
      }
      throw err;
    }
  }

  // A re-invite sent while this acceptance held its claim is a second pending row for the address
  await revokePendingInvitationsFor(invitation.email);

  const granted: string[] = [];
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
      granted.push(String(board.project));
    } catch (err) {
      console.error("Failed to grant an invited board:", err);
    }
  }

  void logInstanceAudit({
    action: "invitation_accepted",
    user: user._id,
    actorUsername: user.username,
    target: invitation.email,
    detail: `as ${authority.role === "admin" ? "an administrator" : "a member"}, account ${user.username}${account.identity ? `, signing in with ${account.identity.provider}` : ""}`,
  });

  const { token: sessionToken, absoluteExpiresAt } = await createSession({
    userId: user._id,
    userAgent: request.headers.get("user-agent"),
    ip: clientIp,
  });

  const response = NextResponse.json(
    {
      username: user.username,
      landing: granted[0] ?? null,
    },
    { status: 201 }
  );
  response.headers.append("Set-Cookie", buildSessionCookie(sessionToken, absoluteExpiresAt, request));
  for (const cookie of legacySessionCookies(request)) {
    response.headers.append("Set-Cookie", cookie);
  }
  return response;
}
