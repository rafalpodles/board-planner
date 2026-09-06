import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/db";
import { MIN_PASSWORD_LENGTH, PASSWORD_COST_FACTOR } from "@/lib/auth";
import { isValidEmail, normaliseEmail } from "@/lib/email";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { notifyAddressChanged, notifyPasswordChanged } from "@/lib/security-mail";
import { invalidateResetTokens } from "@/lib/password-reset";
import { clearAccountAttempts } from "@/lib/rate-limit";
import { duplicateKeyField } from "@/lib/mongo-errors";
import { withAdmin } from "@/lib/middleware";
import { revokeUserSessions } from "@/lib/session";
import { User } from "@/models/user";

export const GET = withAdmin(async (_request, { params }) => {
  const { userId } = await params;
  await connectDB();

  const user = await User.findById(userId);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json(user);
});

export const PUT = withAdmin(async (request, { params, user: admin }) => {
  const { userId } = await params;
  await connectDB();

  // Deliberately without +password: save() writes a modified path whether or not it was selected,
  // and selecting it makes `required` validate on a legacy row that has no hash — turning a
  // role-only edit into a 500 about a password nobody touched.
  const target = await User.findById(userId);
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  let body: { role?: unknown; password?: unknown; email?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const previousRole = target.role;
  let roleWasChanged = false;

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
    if (body.role === "member" && target.role === "admin") {
      const adminCount = await User.countDocuments({ role: "admin" });
      if (adminCount <= 1) {
        return NextResponse.json(
          { error: "Cannot demote the last admin" },
          { status: 400 }
        );
      }
    }
    roleWasChanged = body.role !== previousRole;
    target.role = body.role as "admin" | "member";
  }

  // A worker's account is deliberately un-loginable, and both halves of that promise live here: a
  // password makes it loginable, and an address makes it resettable. Refusing one and not the other
  // only moves the escape a slice later. Note this keys on `kind`, so it does not cover the `pm`
  // identity, which is stored as a person — BP-348.
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
      const taken = await User.exists({ email, _id: { $ne: target._id } });
      if (taken) {
        return NextResponse.json(
          { error: "That email is already on another account" },
          { status: 409 }
        );
      }
    }
    emailWasChanged = email !== previousEmail;
    target.email = email;
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

  if (passwordWasSet) {
    // A link already in the target's inbox would otherwise still work, and overwrite the password
    // the admin has just handed them
    await invalidateResetTokens(target._id);
    // Before the save, not after: a revoke that throws here leaves the account exactly as it was,
    // and the admin retries. The other order commits the new password, answers 500, and leaves the
    // old holder signed in — a failure that reads to the admin as "nothing happened".
    await revokeUserSessions(target._id);
  }

  try {
    await target.save();
  } catch (err) {
    if (duplicateKeyField(err) === "email") {
      return NextResponse.json(
        { error: "That email is already on another account" },
        { status: 409 }
      );
    }
    throw err;
  }

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

export const DELETE = withAdmin(async (_request, { params, user: admin }) => {
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

  const user = await User.findById(userId);
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
  if (user.role === "admin") {
    const adminCount = await User.countDocuments({ role: "admin" });
    if (adminCount <= 1) {
      return NextResponse.json(
        { error: "Cannot delete the last admin" },
        { status: 400 }
      );
    }
  }

  // The delete's own answer, not a discarded one: two administrators deleting the same account
  // otherwise both hear that they did it, and the checks above are read-then-write.
  const deleted = await User.findByIdAndDelete(user._id);
  if (!deleted) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  await revokeUserSessions(user._id);

  // After the delete, and named rather than referenced: the account is gone, so this row is the
  // only place it is recorded that it ever existed or who removed it.
  void logInstanceAudit({
    action: "user_deleted",
    user: admin._id,
    actorUsername: admin.username,
    target: user.username,
    detail: user.role === "admin" ? "an administrator" : "a member",
  });

  return NextResponse.json({ message: "User deleted" });
});
