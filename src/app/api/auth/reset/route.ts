import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/request-body";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/db";
import { getClientIp, MIN_PASSWORD_LENGTH, PASSWORD_COST_FACTOR } from "@/lib/auth";
import {
  anonymousMultiplier,
  clearAccountAttempts,
  isRateLimited,
  recordFailedAttempt,
  sourceKey,
} from "@/lib/rate-limit";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { notifyPasswordChanged } from "@/lib/security-mail";
import {
  consumeResetToken,
  invalidateResetTokens,
  releaseResetToken,
} from "@/lib/password-reset";
import { provenanceRefusal, revokeUserSessions } from "@/lib/session";
import { User } from "@/models/user";

const ATTEMPTS_PER_SOURCE = 20;

const REFUSALS: Record<string, string> = {
  unknown: "This link is not valid. Ask for a new one.",
  expired: "This link has expired. Ask for a new one.",
  used: "This link has already been used. Ask for a new one.",
};

export async function POST(request: Request) {
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  const clientIp = getClientIp(request);
  const throttleKey = sourceKey(clientIp ?? "-", "password-reset-use");
  if (await isRateLimited(throttleKey, anonymousMultiplier(clientIp, ATTEMPTS_PER_SOURCE))) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in 15 minutes." },
      { status: 429 }
    );
  }
  await recordFailedAttempt(throttleKey);

  const read = await readJsonBody<{ token?: unknown; newPassword?: unknown }>(request);
  if (!read.ok) return read.response;
  const body = read.value;

  const { token, newPassword } = body;
  if (typeof token !== "string" || typeof newPassword !== "string") {
    return NextResponse.json({ error: "token and newPassword are required" }, { status: 400 });
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 }
    );
  }

  await connectDB();

  const hashed = await bcrypt.hash(newPassword, PASSWORD_COST_FACTOR);

  const outcome = await consumeResetToken(token);
  if (!outcome.ok) {
    return NextResponse.json({ error: REFUSALS[outcome.reason] }, { status: 400 });
  }

  const user = await User.findById(outcome.userId).select("username kind email");
  if (!user) {
    return NextResponse.json({ error: REFUSALS.unknown }, { status: 400 });
  }
  if (user.kind === "machine") {
    return NextResponse.json({ error: REFUSALS.unknown }, { status: 400 });
  }

  await revokeUserSessions(user._id);

  try {
    await User.updateOne({ _id: user._id }, { $set: { password: hashed } });
  } catch (err) {
    await releaseResetToken(token).catch(() => {});
    throw err;
  }

  await clearAccountAttempts(user.username).catch(() => {});

  await invalidateResetTokens(user._id);

  void logInstanceAudit({
    action: "user_password_reset_by_email",
    user: user._id,
    actorUsername: user.username,
    target: user.username,
    detail: clientIp ? `from ${clientIp}` : "from an unknown address",
  });

  void notifyPasswordChanged({
    email: user.email,
    username: user.username,
    how: "reset_link",
    from: clientIp ? `from ${clientIp}` : "from an unknown address",
  });

  return NextResponse.json({ ok: true });
}
