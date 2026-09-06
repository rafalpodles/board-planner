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

  if (body.role !== undefined) {
    if (admin.viaMachineCredential) {
      return NextResponse.json(
        { error: "This action requires an interactive session" },
        { status: 403 }
      );
    }
    if (typeof body.role !== "string" || !["admin", "member"].includes(body.role)) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }
    if (target._id.toString() === admin._id.toString() && body.role !== "admin") {
      return NextResponse.json(
        { error: "Cannot change your own role" },
        { status: 400 }
      );
    }
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
    if (email && !isValidEmail(email)) {
      return NextResponse.json(
        { error: "That does not look like an email address" },
        { status: 400 }
      );
    }
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
    await invalidateResetTokens(target._id);
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
    await clearAccountAttempts(target.username).catch(() => {});

    void logInstanceAudit({
      action: "user_password_reset",
      user: admin._id,
      actorUsername: admin.username,
      target: target.username,
    });
    void notifyPasswordChanged({
      email: previousEmail || target.email,
      username: target.username,
      how: "admin",
      actor: admin.username,
    });
  }

  if (emailWasChanged) {
    await invalidateResetTokens(target._id);
  }

  if (emailWasChanged) {
    void logInstanceAudit({
      action: "user_email_changed",
      user: admin._id,
      actorUsername: admin.username,
      target: target.username,
      detail: `${previousEmail || "none"} → ${target.email || "none"}`,
    });
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

  if (admin.viaMachineCredential) {
    return NextResponse.json(
      { error: "This action requires an interactive session" },
      { status: 403 }
    );
  }

  if (!isValidObjectId(userId)) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const user = await User.findById(userId);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (user._id.toString() === admin._id.toString()) {
    return NextResponse.json(
      { error: "Cannot delete yourself" },
      { status: 400 }
    );
  }

  if (user.kind === "machine") {
    return NextResponse.json(
      { error: "A machine account is released under Settings → Workers, not deleted here" },
      { status: 400 }
    );
  }

  if (user.role === "admin") {
    const adminCount = await User.countDocuments({ role: "admin" });
    if (adminCount <= 1) {
      return NextResponse.json(
        { error: "Cannot delete the last admin" },
        { status: 400 }
      );
    }
  }

  const deleted = await User.findByIdAndDelete(user._id);
  if (!deleted) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  void logInstanceAudit({
    action: "user_deleted",
    user: admin._id,
    actorUsername: admin.username,
    target: user.username,
    detail: user.role === "admin" ? "an administrator" : "a member",
  });

  await revokeUserSessions(user._id);

  return NextResponse.json({ message: "User deleted" });
});
