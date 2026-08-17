import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/db";
import { getClientIp } from "@/lib/auth";
import { isEmailConfigured, isValidEmail, normaliseEmail, sendEmail } from "@/lib/email";
import { APP_NAME } from "@/lib/brand";
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

  const body = await request.json();
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
      updates.email = email;
    }
  }
  if (typeof body.emailNotifications === "boolean") {
    updates.emailNotifications = body.emailNotifications;
  }
  if (typeof body.collapseEmptyColumns === "boolean") {
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
    void notifyPreviousAddress(previousEmail, user.username);
  }

  return NextResponse.json(updated);
});

async function notifyPreviousAddress(previousEmail: string, username: string): Promise<void> {
  if (!previousEmail || !isEmailConfigured()) return;
  try {
    await sendEmail({
      to: previousEmail,
      subject: `The email address on your ${APP_NAME} account changed`,
      text: [
        `The email address for ${username} was changed, so this address can no longer be used to`,
        "reset that account's password.",
        "",
        "If that was not you, ask an administrator to set a password for the account — whoever made",
        "this change can otherwise request a reset link to their own inbox.",
      ].join("\n"),
    });
  } catch (err) {
    // Nobody is waiting on this, so an unhandled rejection here would take the process down over a
    // mail server having a bad afternoon
    console.error("Could not tell the previous address it was replaced:", err);
  }
}
