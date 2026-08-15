import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/db";
import { getClientIp, PASSWORD_COST_FACTOR } from "@/lib/auth";
import { withAuth } from "@/lib/middleware";
import {
  EXCLUSIVE_SOURCE_ATTEMPTS,
  lockoutKey,
  sourceKey,
  withLockout,
} from "@/lib/rate-limit";
import { revokeUserSessions } from "@/lib/session";
import { User } from "@/models/user";

const MIN_PASSWORD_LENGTH = 8;

export const PUT = withAuth(async (request, { user }) => {
  await connectDB();

  let body: { currentPassword?: unknown; newPassword?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { currentPassword, newPassword } = body;
  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    return NextResponse.json(
      { error: "currentPassword and newPassword are required" },
      { status: 400 }
    );
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 }
    );
  }
  if (newPassword === currentPassword) {
    return NextResponse.json(
      { error: "New password must differ from the current one" },
      { status: 400 }
    );
  }

  // password is select:false, so the authenticated user object never carries the hash
  const record = await User.findById(user._id).select("+password");
  if (!record) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { lockedOut, result: passwordMatches } = await withLockout(
    lockoutKey(getClientIp(request) ?? "-", user.username, "password-change"),
    async () => ((await bcrypt.compare(currentPassword, record.password)) ? true : null),
    sourceKey(String(user._id), "password-change"),
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

  record.password = await bcrypt.hash(newPassword, PASSWORD_COST_FACTOR);
  await record.save();

  await revokeUserSessions(user._id, user.sessionId);

  return NextResponse.json({ ok: true });
});
