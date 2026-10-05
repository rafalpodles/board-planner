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
import { applyAdminGroup } from "@/lib/oidc/admin-group";
import { logProjectAudit } from "@/lib/projectAudit";
import { IInvitation } from "@/types";
import type { ScopedDb } from "@/lib/db-scope";
import { organisationOf } from "@/lib/db-scope";

export interface NewAccount {
  username: string;
  fullName: string;
  /** Null for an account that signs in through an identity provider only. */
  passwordHash: string | null;
  identity?: { provider: string; issuer: string; subject: string; email: string };
  /** Whether that provider's word on the address is proof of the mailbox (not GitHub's). */
  providerProvesAddress?: boolean;
  /** The groups that identity's provider named, for `OIDC_ADMIN_GROUP`. */
  groups?: string[];
}

/**
 * Everything after the link was claimed: what it may still grant, the account, the identity it
 * signs in with, the boards, and the session. Shared by the password and the provider paths so
 * the two cannot drift apart on what an invitation grants.
 */
export async function completeAcceptance(
  db: ScopedDb,
  invitation: IInvitation,
  account: NewAccount,
  request: Request,
  clientIp: string | null
): Promise<NextResponse> {
  // Nothing exists yet that the claim is tied to, so a failure here gives the link back
  const authority = await authorityAtAcceptance(db, invitation).catch(async (err) => {
    await releaseInvitation(db, invitation._id).catch(() => {});
    throw err;
  });
  if (!authority) {
    await revokeClaimedInvitation(db, invitation._id);
    return NextResponse.json({ error: INVITATION_REFUSALS.revoked }, { status: 400 });
  }

  let user;
  try {
    user = await db.User.create({
      username: account.username,
      ...(account.passwordHash ? { password: account.passwordHash } : {}),
      fullName: account.fullName,
      email: invitation.email,
      // Proven when the link travelled by mail, or when a provider whose word is proof vouched
      emailVerifiedAt:
        invitation.deliveredAs === "email" || (account.identity && account.providerProvesAddress) ? new Date() : null,
      role: authority.role,
    });
  } catch (err) {
    await releaseInvitation(db, invitation._id).catch(() => {});
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

  if (account.identity) {
    try {
      await db.Identity.create({ user: user._id, ...account.identity, lastUsedAt: new Date() });
    } catch (err) {
      // Linked to another account in the meantime, before the claim was tied to anything: both the
      // account and the claim can still be undone
      await db.User.deleteOne({ _id: user._id }).catch(() => {});
      await releaseInvitation(db, invitation._id).catch(() => {});
      if (duplicateKeyField(err)) {
        return NextResponse.json(
          { error: "That sign-in is already linked to another account." },
          { status: 409 }
        );
      }
      throw err;
    }
  }

  let stillHeld = true;
  try {
    stillHeld = await recordAcceptance(db, invitation._id, user._id);
  } catch (err) {
    // The account exists either way, so its boards are still granted below. Tried again, since a
    // claim left unrecorded stays revocable, and revoking it would mark a used invitation withdrawn
    console.error("Failed to record an invitation's acceptance:", err);
    stillHeld = await recordAcceptance(db, invitation._id, user._id).catch(() => true);
  }
  if (!stillHeld) {
    await db.Identity.deleteMany({ user: user._id }).catch(() => {});
    await db.User.deleteOne({ _id: user._id }).catch(() => {});
    return NextResponse.json({ error: INVITATION_REFUSALS.revoked }, { status: 400 });
  }
  // A re-invite sent while this acceptance held its claim is a second pending row for the address
  await revokePendingInvitationsFor(db, invitation.email);

  const granted: string[] = [];
  for (const board of authority.boards) {
    try {
      await db.Grant.findOneAndUpdate(
        { subject: user._id, objectType: "project", object: board.project },
        { $set: { relation: board.relation }, $setOnInsert: { createdBy: board.addedBy } },
        { upsert: true }
      );
      void logProjectAudit(
        db,
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

  void logInstanceAudit(db, {
    action: "invitation_accepted",
    user: user._id,
    actorUsername: user.username,
    target: invitation.email,
    detail: `as ${authority.role === "admin" ? "an administrator" : "a member"}, account ${user.username}${account.identity ? `, signing in with ${account.identity.provider}` : ""}`,
  });

  if (account.identity) await applyAdminGroup(db, user, account.identity.provider, account.groups ?? []);

  const { token: sessionToken, absoluteExpiresAt } = await createSession({
    userId: user._id,
    organisation: organisationOf(user),
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
