import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/db";
import { getClientIp } from "@/lib/auth";
import { isValidEmail, normaliseEmail } from "@/lib/email";
import { notifyAddressChanged } from "@/lib/security-mail";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { withAuth } from "@/lib/middleware";
import { FULL_NAME_RULE, isValidFullName, normaliseFullName } from "@/lib/identifiers";
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
    if (user.viaMachineCredential) {
      return NextResponse.json(
        { error: "This action requires an interactive session" },
        { status: 403 }
      );
    }
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
    if (email && !isValidEmail(email)) {
      return NextResponse.json(
        { error: "That does not look like an email address" },
        { status: 400 }
      );
    }

    if (email !== previousEmail) {
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
      await clearAttempts(sourceKey(String(user._id), "email-change")).catch(() => {});

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

  const previousFullName = user.fullName ?? "";

  if (body.fullName !== undefined) {
    if (typeof body.fullName !== "string") {
      return NextResponse.json({ error: FULL_NAME_RULE }, { status: 400 });
    }
    const fullName = normaliseFullName(body.fullName);
    if (!isValidFullName(fullName)) {
      return NextResponse.json({ error: FULL_NAME_RULE }, { status: 400 });
    }
    if (fullName !== previousFullName) {
      updates.fullName = fullName;
    }
  }

  if (typeof body.emailDigest === "boolean") {
    updates.emailDigest = body.emailDigest;
  }

  if (typeof body.emailNotifications === "boolean") {
    updates.emailNotifications = body.emailNotifications;
  }
  if (typeof body.collapseEmptyColumns === "boolean") {
    updates.collapseEmptyColumns = body.collapseEmptyColumns;
  }

  if (Object.keys(updates).length === 0) {
    if (body.email !== undefined || body.fullName !== undefined) {
      return NextResponse.json(await User.findById(user._id));
    }
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

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

  if (!updated) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (typeof updates.fullName === "string") {
    void logInstanceAudit({
      action: "user_full_name_changed_self",
      user: user._id,
      actorUsername: user.username,
      target: user.username,
      detail: `${previousFullName || "none"} → ${updates.fullName}`,
    });
  }

  if (typeof updates.email === "string" && updates.email !== previousEmail) {
    void logInstanceAudit({
      action: "user_email_changed_self",
      user: user._id,
      actorUsername: user.username,
      target: user.username,
      detail: `${previousEmail || "none"} → ${updates.email || "none"}`,
    });
    void notifyAddressChanged({
      previousEmail,
      username: user.username,
      newEmail: updates.email,
    });
  }

  return NextResponse.json(updated);
});

