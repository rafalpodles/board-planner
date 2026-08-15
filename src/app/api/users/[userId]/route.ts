import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/db";
import { MIN_PASSWORD_LENGTH, PASSWORD_COST_FACTOR } from "@/lib/auth";
import { logInstanceAudit } from "@/lib/instanceAudit";
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

  // +password because the hash is select:false and a path the document never loaded is a path
  // save() has no reason to write. The response is unaffected: toJSON strips it.
  const target = await User.findById(userId).select("+password");
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const body = await request.json();

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
    if (!["admin", "member"].includes(body.role)) {
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
    target.role = body.role;
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
    // Otherwise this endpoint is the way around the current-password check on Settings → Security,
    // which is the only thing standing between a borrowed admin session and a locked-out owner.
    if (target._id.toString() === admin._id.toString()) {
      return NextResponse.json(
        { error: "Change your own password under Settings → Security" },
        { status: 400 }
      );
    }
    if (typeof body.password !== "string" || body.password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
        { status: 400 }
      );
    }
    target.password = await bcrypt.hash(body.password, PASSWORD_COST_FACTOR);
    passwordWasSet = true;
  }

  await target.save();

  if (passwordWasSet) {
    // Every session, with no exception: the admin is not one of them, and whoever was signed in as
    // this account under the old password must not stay signed in under it.
    await revokeUserSessions(target._id);
    await logInstanceAudit({
      action: "user_password_reset",
      user: admin._id,
      target: target.username,
    });
  }

  return NextResponse.json(target);
});

export const DELETE = withAdmin(async (_request, { params, user: admin }) => {
  const { userId } = await params;
  await connectDB();

  if (userId === admin._id.toString()) {
    return NextResponse.json(
      { error: "Cannot delete yourself" },
      { status: 400 }
    );
  }

  const user = await User.findByIdAndDelete(userId);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  await revokeUserSessions(userId);

  return NextResponse.json({ message: "User deleted" });
});
