import { NextResponse } from "next/server";
import { passwordSignInEnabled, passwordSignInOff } from "@/lib/password-sign-in";
import { HydratedDocument, isValidObjectId } from "mongoose";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/db";
import type { ScopedDb } from "@/lib/db-scope";
import { MIN_PASSWORD_LENGTH, PASSWORD_COST_FACTOR } from "@/lib/auth";
import { isValidEmail, normaliseEmail } from "@/lib/email";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { revokePendingInvitationsFor } from "@/lib/invitations";
import { notifyAddressChanged, notifyPasswordChanged } from "@/lib/security-mail";
import { invalidateResetTokens } from "@/lib/password-reset";
import { cancelEmailChange } from "@/lib/email-change";
import { clearAccountAttempts } from "@/lib/rate-limit";
import { duplicateKeyField } from "@/lib/mongo-errors";
import { withAdmin } from "@/lib/middleware";
import { boardsLeftWithoutOwner, boardsOnlyOwnedBy } from "@/lib/grants";
import { revokeUserCredentials, revokeUserSessions } from "@/lib/session";
import { IUser } from "@/types";

// What "the last admin" counts: an administrator who can still sign in and act (BP-832)
const ACTIVE_ADMINS = { role: "admin", deactivatedAt: null } as const;

export const PUT = withAdmin(async (request, { params, user: admin, db }) => {
  const { userId } = await params;
  await connectDB();

  // Deliberately without +password: save() writes a modified path whether or not it was selected,
  // and selecting it makes `required` validate on a legacy row that has no hash — turning a
  // role-only edit into a 500 about a password nobody touched.
  const target = await db.User.findById(userId);
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  let body: {
    role?: unknown;
    password?: unknown;
    email?: unknown;
    confirmEmail?: unknown;
    signOutEverywhere?: unknown;
    deactivate?: unknown;
    reactivate?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body.password !== undefined && !passwordSignInEnabled()) return passwordSignInOff();
  // It would revoke and unlink like a sign-out, and the account signs in by no path anyway
  if (body.password !== undefined && target.deactivatedAt) {
    return NextResponse.json({ error: `${target.username} is deactivated; reactivate them first` }, { status: 400 });
  }

  const chosen = (
    [
      ["confirm", body.confirmEmail],
      ["signOut", body.signOutEverywhere],
      ["deactivate", body.deactivate],
      ["reactivate", body.reactivate],
    ] as const
  ).filter(([, flag]) => flag === true);
  const action = chosen.length > 0;
  const actions = chosen.length;
  const edits = [body.role, body.email, body.password].filter((v) => v !== undefined).length;
  if (actions > 1 || (action && edits > 0)) {
    return NextResponse.json({ error: "One account action at a time, with nothing else" }, { status: 400 });
  }
  if (action) {
    return accountAction(db, target, admin, chosen[0][0]);
  }

  const previousRole = target.role;
  let roleWasChanged = false;
  let demotingAnActiveAdmin = false;

  // Update role
  if (body.role !== undefined) {
    // Promotion is the second half of the machine-credential escape: create an account, raise it,
    // then sign in as it. Gated exactly like account creation and the five interactive endpoints.
    if (admin.viaMachineCredential) {
      return NextResponse.json(
        { error: "This action requires an interactive session" },
        { status: 403 }
      );
    }
    if (typeof body.role !== "string" || !["admin", "member"].includes(body.role)) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }
    // Prevent admin from demoting themselves
    if (target._id.toString() === admin._id.toString() && body.role !== "admin") {
      return NextResponse.json(
        { error: "Cannot change your own role" },
        { status: 400 }
      );
    }
    // Prevent demoting the last admin
    // A deactivated administrator is no longer one of those keeping the instance administered
    if (body.role === "member" && target.role === "admin" && !target.deactivatedAt) {
      const adminCount = await db.User.countDocuments(ACTIVE_ADMINS);
      if (adminCount <= 1) {
        return NextResponse.json(
          { error: "Cannot demote the last admin" },
          { status: 400 }
        );
      }
      demotingAnActiveAdmin = true;
    }
    roleWasChanged = body.role !== previousRole;
    target.role = body.role as "admin" | "member";
  }

  // A machine account (a worker's, or pm) is un-loginable: a password or an address would undo that
  const wantsCredentialChange = body.email !== undefined || body.password !== undefined;
  if (wantsCredentialChange && target.kind === "machine") {
    return NextResponse.json(
      { error: "A machine account signs in with a token, not a password" },
      { status: 400 }
    );
  }

  let emailWasChanged = false;
  const previousEmail = target.email ?? "";
  if (body.email !== undefined) {
    // Gated like the password, and for the sharper reason: once a reset can be requested by email,
    // whoever writes this field decides where that link lands. An account's address is the account.
    if (admin.viaMachineCredential) {
      return NextResponse.json(
        { error: "This action requires an interactive session" },
        { status: 403 }
      );
    }
    if (typeof body.email !== "string") {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }
    const email = normaliseEmail(body.email);
    // Empty clears it, which is the only way to undo a typo that took somebody else's address
    if (email && !isValidEmail(email)) {
      return NextResponse.json(
        { error: "That does not look like an email address" },
        { status: 400 }
      );
    }
    // Asked before anything is touched, because the session revoke below happens before the save:
    // learning about the collision from the index would leave the target signed out of everything
    // over an address that was never stored. The index stays the final arbiter for the race.
    if (email && email !== previousEmail) {
      const taken = await db.User.exists({ email, _id: { $ne: target._id } });
      if (taken) {
        return NextResponse.json(
          { error: "That email is already on another account" },
          { status: 409 }
        );
      }
    }
    emailWasChanged = email !== previousEmail;
    target.email = email;
    if (emailWasChanged) target.emailVerifiedAt = null;
  }

  let passwordWasSet = false;
  if (body.password !== undefined) {
    // Same escape as promotion, one step shorter: set an admin's password and sign in as them.
    if (admin.viaMachineCredential) {
      return NextResponse.json(
        { error: "This action requires an interactive session" },
        { status: 403 }
      );
    }
    if (typeof body.password !== "string" || body.password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
        { status: 400 }
      );
    }
    // An ergonomics guard, not a containment boundary — a second admin can still take this account
    // over. It keeps the one-click self-lockout away from a screen whose other buttons are routine.
    if (target._id.toString() === admin._id.toString()) {
      return NextResponse.json(
        { error: "Change your own password under Settings → Security" },
        { status: 400 }
      );
    }
    target.password = await bcrypt.hash(body.password, PASSWORD_COST_FACTOR);
    passwordWasSet = true;
  }

  // Written and counted again before anything else is: an administrator demoted or deactivated by
  // a request racing this one counted this one as still there, as this one counted them (BP-841)
  let demotedHere = false;
  if (demotingAnActiveAdmin) {
    const demoted = await db.User.updateOne({ _id: target._id, role: "admin" }, { $set: { role: "member" } });
    demotedHere = demoted.modifiedCount > 0;
    // Written above, so the save must not write it again over a promotion landing in between
    target.unmarkModified("role");
    if (demotedHere && (await db.User.countDocuments(ACTIVE_ADMINS)) === 0) {
      await db.User.updateOne({ _id: target._id }, { $set: { role: "admin" } });
      return NextResponse.json({ error: "Cannot demote the last admin" }, { status: 409 });
    }
    // A racing request demoted them first and has recorded it; this one changed nothing
    if (!demotedHere) roleWasChanged = false;
  }
  // The demotion is already written, so a request refused or failing after it must take it back:
  // otherwise it stands unrecorded behind an answer saying nothing was done
  const undoDemotion = async () => {
    if (demotedHere) await db.User.updateOne({ _id: target._id, role: "member" }, { $set: { role: "admin" } });
  };

  try {
    if (passwordWasSet) {
      // A link already in the target's inbox would otherwise still work, and overwrite the password
      // the admin has just handed them
      await invalidateResetTokens(target._id);
      // Before the save: a failure revokes too much rather than leaving the old holder a way in
      const revoked = await revokeUserCredentials(target._id);
      if (revoked?.identitiesUnlinked) {
        void logInstanceAudit({
          action: "identity_unlinked",
          user: admin._id,
          actorUsername: admin.username,
          target: target.username,
          detail: "every sign-in provider, by an administrator setting the password",
        });
      }
    }

    try {
      await target.save();
    } catch (err) {
      if (duplicateKeyField(err) === "email") {
        await undoDemotion();
        return NextResponse.json(
          { error: "That email is already on another account" },
          { status: 409 }
        );
      }
      throw err;
    }
  } catch (err) {
    await undoDemotion().catch(() => {});
    throw err;
  }
  if (emailWasChanged) await revokePendingInvitationsFor(target.email);

  // What an account may do on this instance, which is the change the branch above gates on
  // `viaMachineCredential` precisely because it is the escalation path — and then left no trace of.
  // The direction is in `detail`, the way the address change carries old → new.
  if (roleWasChanged) {
    void logInstanceAudit({
      action: "user_role_changed",
      user: admin._id,
      actorUsername: admin.username,
      target: target.username,
      detail: `${previousRole} → ${target.role}`,
    });
  }

  if (passwordWasSet) {
    // Handing somebody a password is the administrator's answer to "I cannot get in", so it has to
    // lift a login lockout too — including one an attacker aimed at them, which on a deployment
    // with no client address anybody can fill (BP-353). After the save, because unlike the revoke
    // above there is nothing to undo if it fails.
    await clearAccountAttempts(target.username).catch(() => {});

    void logInstanceAudit({
      action: "user_password_reset",
      user: admin._id,
      actorUsername: admin.username,
      target: target.username,
    });
    // The account holder is the one person this happens to who was not in the room for it. Sent to
    // the address the account had on the way in, which is the same one in the ordinary case — and
    // in the case that matters, one PUT setting a password AND repointing the address, it is the
    // victim's inbox rather than the inbox the change just handed the account to.
    void notifyPasswordChanged({
      email: previousEmail || target.email,
      username: target.username,
      how: "admin",
      actor: admin.username,
    });
  }

  if (emailWasChanged) {
    // A link already sent to the old address would otherwise keep working for its hour — which is
    // exactly the address this change is moving away from
    await invalidateResetTokens(target._id);
    // And a change the account itself asked for would otherwise overwrite this one once confirmed
    await cancelEmailChange(target._id);
  }

  // The quieter half of the same takeover: repointing an address takes an account over at the next
  // reset, and unlike a password change it signs nobody out, so this row is the only trace there is
  if (emailWasChanged) {
    void logInstanceAudit({
      action: "user_email_changed",
      user: admin._id,
      actorUsername: admin.username,
      target: target.username,
      detail: `${previousEmail || "none"} → ${target.email || "none"}`,
    });
    // To the address being taken off the account, exactly as the self-service path does — this is
    // the half where the person doing it is not the person losing the recovery address.
    void notifyAddressChanged({
      previousEmail,
      username: target.username,
      newEmail: target.email,
      actor: admin.username,
    });
  }

  return NextResponse.json(target);
});

export const DELETE = withAdmin(async (_request, { params, user: admin, db }) => {
  const { userId } = await params;
  await connectDB();

  // The same refusal the three writes above make, for a sharper reason than any of theirs: this is
  // the one thing on this route that cannot be undone, and the only one an unattended credential
  // could be made to do.
  if (admin.viaMachineCredential) {
    return NextResponse.json(
      { error: "This action requires an interactive session" },
      { status: 403 }
    );
  }

  // Answered rather than thrown: `findById` on something that is not an id rejects with a
  // CastError, which leaves this handler as a 500 about nothing. A caller who guessed a malformed
  // id gets the same answer as one who guessed a wrong one.
  if (!isValidObjectId(userId)) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const user = await db.User.findById(userId);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // The loaded document, the way both guards in PUT do it, and not the path segment: BSON resolves
  // a hex id case-insensitively while `===` does not, so `E2E…A001` used to be a different string
  // and the same account — which walked straight past this and left instances with no
  // administrator at all (BP-546).
  if (user._id.toString() === admin._id.toString()) {
    return NextResponse.json(
      { error: "Cannot delete yourself" },
      { status: 400 }
    );
  }

  // A machine's account is not a person to delete from here — the same reason GET filters them out
  // of the list this screen is built from. Deleting one takes the fleet's identity with it, and
  // every worker call then fails with "this worker has no identity yet", naming nothing that
  // explains why.
  if (user.kind === "machine") {
    return NextResponse.json(
      { error: "A machine account is released under Settings → Workers, not deleted here" },
      { status: 400 }
    );
  }

  // The invariant PUT keeps for demotion, kept here too. Unreachable while the guard above holds —
  // an admin cannot be looking at the last admin unless they are looking at themselves — which is
  // exactly why it is here: that guard failed once, and an instance with no administrator cannot be
  // repaired from the product.
  if (user.role === "admin" && !user.deactivatedAt) {
    const adminCount = await db.User.countDocuments(ACTIVE_ADMINS);
    if (adminCount <= 1) {
      return NextResponse.json(
        { error: "Cannot delete the last admin" },
        { status: 400 }
      );
    }
  }

  const soleOwned = await boardsOnlyOwnedBy(String(user._id));
  if (soleOwned.length > 0) {
    const names = soleOwned.map((b) => `${b.name} (${b.key})`).join(", ");
    return NextResponse.json(
      {
        error: `${user.username} is the only owner of ${names}. Make someone else an owner there before deleting this account.`,
        boards: soleOwned,
      },
      { status: 409 }
    );
  }

  // A delete cannot be undone, so the account first stops counting, as a deactivated one does, and
  // the two invariants are counted again without it: a demotion, deactivation or removal racing
  // this one counted this account as still there (BP-841)
  if (!user.deactivatedAt) {
    const markedAt = new Date();
    const marked = await db.User.updateOne({ _id: user._id, deactivatedAt: null }, { $set: { deactivatedAt: markedAt } });
    if (marked.modifiedCount > 0) {
      const lastAdminGone = user.role === "admin" && (await db.User.countDocuments(ACTIVE_ADMINS)) === 0;
      const ownerless = lastAdminGone ? [] : await boardsLeftWithoutOwner(String(user._id));
      if (lastAdminGone || ownerless.length > 0) {
        // Only this request's own mark: a deactivation landing meanwhile stays
        await db.User.updateOne({ _id: user._id, deactivatedAt: markedAt }, { $set: { deactivatedAt: null } });
        return NextResponse.json(
          {
            error: lastAdminGone
              ? "Cannot delete the last admin"
              : "Another owner of the same board was removed meanwhile",
          },
          { status: 409 }
        );
      }
    }
  }

  // The delete's own answer, not a discarded one: two administrators deleting the same account
  // otherwise both hear that they did it, and the checks above are read-then-write.
  const deleted = await db.User.findByIdAndDelete(user._id);
  if (!deleted) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // After the delete and BEFORE the revoke, which is the opposite order to the password path
  // above — and for the same reason it uses that one. There, nothing is committed until the save,
  // so a failed revoke must leave the account untouched. Here the account is already gone, and a
  // revoke that throws would take the only record of it having existed with it.
  void logInstanceAudit({
    action: "user_deleted",
    user: admin._id,
    actorUsername: admin.username,
    target: user.username,
    detail: user.role === "admin" ? "an administrator" : "a member",
  });

  await db.Grant.deleteMany({ subject: user._id });
  // A link left behind would refuse the same person's provider as "already linked" for good
  await db.Identity.deleteMany({ user: user._id });
  await revokeUserSessions(user._id);

  return NextResponse.json({ message: "User deleted" });
});

/**
 * Two ways an administrator answers "I cannot get in" or "somebody else did" that need no password,
 * so they still work with password sign-in off: vouch for an address, so a provider can sign in by
 * it, and end every session and link the account has (BP-830). Each alone in its request.
 */
async function accountAction(
  db: ScopedDb,
  target: HydratedDocument<IUser>,
  admin: IUser,
  action: "confirm" | "signOut" | "deactivate" | "reactivate"
) {
  if (admin.viaMachineCredential) {
    return NextResponse.json({ error: "This action requires an interactive session" }, { status: 403 });
  }
  if (String(target._id) === String(admin._id)) {
    return NextResponse.json({ error: "Not on your own account" }, { status: 400 });
  }
  if (target.kind === "machine") {
    return NextResponse.json({ error: "A machine account signs in with a token" }, { status: 400 });
  }
  if (action === "confirm") {
    if (!target.email) return NextResponse.json({ error: "This account has no address" }, { status: 400 });
    target.emailVerifiedAt = new Date();
    await target.save();
    void logInstanceAudit({
      action: "user_email_confirmed",
      user: admin._id,
      actorUsername: admin.username,
      target: target.username,
      detail: target.email,
    });
    return NextResponse.json({ ok: true });
  }
  if (action === "deactivate") {
    if (target.deactivatedAt) return NextResponse.json({ ok: true });
    // A deactivated administrator administers nothing, so they no longer count towards keeping one
    if (target.role === "admin" && (await db.User.countDocuments(ACTIVE_ADMINS)) <= 1) {
      return NextResponse.json({ error: "Cannot deactivate the last admin" }, { status: 400 });
    }
    // The rule deleting an account keeps: a board owned only by somebody who can do nothing is a
    // board nobody can manage
    const soleOwned = await boardsOnlyOwnedBy(String(target._id));
    if (soleOwned.length > 0) {
      const names = soleOwned.map((b) => `${b.name} (${b.key})`).join(", ");
      return NextResponse.json(
        {
          error: `${target.username} is the only owner of ${names}. Make someone else an owner there before deactivating this account.`,
          boards: soleOwned,
        },
        { status: 409 }
      );
    }
    target.deactivatedAt = new Date();
    await target.save();
    // Two administrators, or two co-owners, deactivating each other at once each counted the other
    // as still active; one of them yields rather than leave nobody to run the instance or a board
    const lastAdminGone = target.role === "admin" && (await db.User.countDocuments(ACTIVE_ADMINS)) === 0;
    const ownerless = lastAdminGone ? [] : await boardsLeftWithoutOwner(String(target._id));
    if (lastAdminGone || ownerless.length > 0) {
      target.deactivatedAt = null;
      await target.save();
      return NextResponse.json(
        { error: lastAdminGone ? "Cannot deactivate the last admin" : "Another owner of the same board was deactivated meanwhile" },
        { status: 409 }
      );
    }
    // After the flag, so a session minted in between is refused by getAuthUser anyway. Its sign-in
    // providers stay linked: every sign-in is refused while deactivated, and a reactivated account
    // on an instance without passwords needs one to come back by
    await revokeUserCredentials(target._id, null, { keepIdentities: true });
    await invalidateResetTokens(target._id);
    void logInstanceAudit({
      action: "user_deactivated",
      user: admin._id,
      actorUsername: admin.username,
      target: target.username,
      detail: "",
    });
    return NextResponse.json({ ok: true });
  }
  if (action === "reactivate") {
    if (!target.deactivatedAt) return NextResponse.json({ ok: true });
    // Anything minted in the instant between the flag and the first revoke was refused while
    // deactivated, and would work again from here; it goes now, while sign-in is still refused
    await revokeUserCredentials(target._id, null, { keepIdentities: true });
    target.deactivatedAt = null;
    await target.save();
    void logInstanceAudit({
      action: "user_reactivated",
      user: admin._id,
      actorUsername: admin.username,
      target: target.username,
      detail: "",
    });
    return NextResponse.json({ ok: true });
  }
  // Deactivating ended every session already; this would only unlink the providers it keeps
  if (target.deactivatedAt) {
    return NextResponse.json({ error: `${target.username} is deactivated and signed out already` }, { status: 400 });
  }
  const revoked = await revokeUserCredentials(target._id);
  await invalidateResetTokens(target._id);
  void logInstanceAudit({
    action: "user_signed_out_everywhere",
    user: admin._id,
    actorUsername: admin.username,
    target: target.username,
    detail: `${revoked?.identitiesUnlinked ?? 0} sign-in provider(s) unlinked`,
  });
  return NextResponse.json({ ok: true });
}
