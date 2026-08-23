import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/db";
import { getClientIp } from "@/lib/auth";
import { isValidEmail, normaliseEmail } from "@/lib/email";
import { notifyAddressChanged } from "@/lib/security-mail";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { withAuth } from "@/lib/middleware";
import { duplicateKeyField } from "@/lib/mongo-errors";
import { invalidateResetTokens } from "@/lib/password-reset";
import {
  clearAttempts,
  EXCLUSIVE_SOURCE_ATTEMPTS,
  lockoutKey,
  sourceKey,
  withLockout,
} from "@/lib/rate-limit";
import { User } from "@/models/user";

export const PUT = withAuth(async (request, { user }) => {
  await connectDB();

  // Both siblings answer 400 here rather than throwing a 500 at whoever sent it, and this route
  // now handles a password too
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  const previousEmail = user.email ?? "";

  if (body.email !== undefined) {
    // The address is where a reset link will land, so a machine credential must not be able to
    // move it — not even on its own account. A stolen `cpat_` that can repoint the owner's address
    // is a stolen token that becomes a password, which is the escape every other gate refuses.
    if (user.viaMachineCredential) {
      return NextResponse.json(
        { error: "This action requires an interactive session" },
        { status: 403 }
      );
    }
    // The admin path refuses this on `kind` and states why: a worker's account is deliberately
    // un-loginable, and an address makes it resettable. `viaMachineCredential` alone does not cover
    // a machine row signed into by cookie, so key on both — defence in depth, not a live hole.
    if (user.kind === "machine") {
      return NextResponse.json(
        { error: "A machine account signs in with a token, not a password" },
        { status: 400 }
      );
    }
    if (typeof body.email !== "string") {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }
    const email = normaliseEmail(body.email);
    // Same rule as the admin path: an address nobody can deliver to is worse than none, because
    // the reset it is meant to receive will look like it was sent
    if (email && !isValidEmail(email)) {
      return NextResponse.json(
        { error: "That does not look like an email address" },
        { status: 400 }
      );
    }

    // Resending the address already on the account is not a change, and must not demand a
    // password: the profile form submits this field alongside the notification toggle, so
    // treating an unchanged value as a change would put a password prompt in front of a checkbox.
    if (email !== previousEmail) {
      // The same proof the password change asks for, because this field can obtain a password.
      // Repointing it takes the account over at the next reset and — unlike a password change —
      // signs nobody out, so a borrowed session was otherwise enough to keep the account for good.
      if (typeof body.currentPassword !== "string" || !body.currentPassword) {
        return NextResponse.json(
          { error: "Your current password is required to change your email address" },
          { status: 400 }
        );
      }
      const record = await User.findById(user._id).select("+password");
      if (!record) {
        return NextResponse.json({ error: "User not found" }, { status: 404 });
      }
      const currentPassword = body.currentPassword;
      const { lockedOut, result: passwordMatches } = await withLockout(
        lockoutKey(getClientIp(request) ?? "-", user.username, "email-change"),
        async () => ((await bcrypt.compare(currentPassword, record.password)) ? true : null),
        sourceKey(String(user._id), "email-change"),
        EXCLUSIVE_SOURCE_ATTEMPTS
      );
      if (lockedOut) {
        return NextResponse.json(
          { error: "Too many failed attempts. Try again later." },
          { status: 429 }
        );
      }
      if (!passwordMatches) {
        return NextResponse.json({ error: "Current password is incorrect" }, { status: 400 });
      }
      // Unlike the login throttle, this gate's source key *is* the account — it is the signed-in
      // user's own id — so the rule that a success must never clear the source dimension does not
      // apply: there is no other account whose guessing budget this could refund. Without it the
      // gate has no exit at all, and ten wrong guesses from a borrowed session refuse the owner
      // their own correct password for the rest of the window, which clearAccountAttempts cannot
      // lift because the block sits outside the account dimension it sweeps (BP-354 review).
      await clearAttempts(sourceKey(String(user._id), "email-change")).catch(() => {});

      // Asked before anything is touched, exactly as the admin path does it: the purge below runs
      // before the write, so learning of the collision from the index alone would destroy the
      // account's outstanding reset links over an address that was never stored — and leave no
      // audit row saying anything happened. The index stays the final arbiter for a concurrent
      // write; this only stops the common case from being destructive (BP-354 review).
      if (email) {
        const taken = await User.exists({ email, _id: { $ne: user._id } });
        if (taken) {
          return NextResponse.json(
            { error: "That email is already on another account" },
            { status: 409 }
          );
        }
      }
      updates.email = email;
    }
  }
  if (body.emailDigest === true || body.emailDigest === false) {
    updates.emailDigest = body.emailDigest;
  }
  if (body.emailNotifications === true || body.emailNotifications === false) {
    updates.emailNotifications = body.emailNotifications;
  }
  if (body.fullName !== undefined) {
    if (typeof body.fullName !== "string") {
      return NextResponse.json({ error: "Invalid fullName" }, { status: 400 });
    }
    const name = body.fullName.trim();
    if (name.length === 0) {
      return NextResponse.json({ error: "Full name cannot be empty" }, { status: 400 });
    }
    if (name.length > 100) {
      return NextResponse.json({ error: "Full name is too long" }, { status: 400 });
    }
    updates.fullName = name;
  }
  if (body.collapseEmptyColumns === true || body.collapseEmptyColumns === false) {
    updates.collapseEmptyColumns = body.collapseEmptyColumns;
  }

  if (Object.keys(updates).length === 0) {
    // Submitting the address already on the account is a no-op, not a malformed request: it is
    // what a client sending the whole profile back does when only the address was left alone.
    if (body.email !== undefined) {
      return NextResponse.json(await User.findById(user._id));
    }
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  // Moving your own address away from an inbox leaves any link already sent to it live for the
  // rest of its hour, which is the wrong answer if you are moving it because that inbox is not
  // yours any more
  if (typeof updates.email === "string") {
    await invalidateResetTokens(user._id);
  }

  let updated;
  try {
    updated = await User.findByIdAndUpdate(
      user._id,
      { $set: updates },
      { returnDocument: "after" }
    );
  } catch (err) {
    if (duplicateKeyField(err) === "email") {
      return NextResponse.json(
        { error: "That email is already on another account" },
        { status: 409 }
      );
    }
    throw err;
  }

  // Deleted between the credential check and the write. Answering 200 with a null body told the
  // caller it worked, and would have audited and mailed about a write that matched nothing.
  if (!updated) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (typeof updates.email === "string" && updates.email !== previousEmail) {
    // The admin path audits the same change for the same reason: repointing an address takes the
    // account over at the next reset and signs nobody out, so the row is the only trace there is.
    // It was audited when somebody else did it and silent when the account itself did — which is
    // the case a borrowed session produces.
    void logInstanceAudit({
      action: "user_email_changed_self",
      user: user._id,
      target: user.username,
      detail: `${previousEmail || "none"} → ${updates.email || "none"}`,
    });
    // Told to the address losing the ability to recover the account, not the one gaining it: the
    // person who needs to hear about this is the one who did not do it.
    void notifyAddressChanged({
      previousEmail,
      username: user.username,
      newEmail: updates.email,
    });
  }

  return NextResponse.json(updated);
});

