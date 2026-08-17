import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/db";
import { getClientIp, MIN_PASSWORD_LENGTH, PASSWORD_COST_FACTOR } from "@/lib/auth";
import {
  anonymousMultiplier,
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

  let body: { token?: unknown; newPassword?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { token, newPassword } = body;
  if (typeof token !== "string" || typeof newPassword !== "string") {
    return NextResponse.json({ error: "token and newPassword are required" }, { status: 400 });
  }
  // Before the token is spent, so a password the server would refuse does not cost somebody their
  // one-time link and send them back to their inbox for another
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 }
    );
  }

  // Guessing 32 random bytes is not the worry; unmetered work is. Two indexed reads and a bcrypt
  // per anonymous request is a bill anybody can run up.
  const clientIp = getClientIp(request);
  const throttleKey = sourceKey(clientIp ?? "-", "password-reset-use");
  if (await isRateLimited(throttleKey, anonymousMultiplier(clientIp, ATTEMPTS_PER_SOURCE))) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in 15 minutes." },
      { status: 429 }
    );
  }
  await recordFailedAttempt(throttleKey);

  await connectDB();

  // Hashed before the token is spent, for the same reason the length is checked first: bcrypt
  // throwing after the claim would leave the person with a dead link and their old password
  const hashed = await bcrypt.hash(newPassword, PASSWORD_COST_FACTOR);

  const outcome = await consumeResetToken(token);
  if (!outcome.ok) {
    return NextResponse.json({ error: REFUSALS[outcome.reason] }, { status: 400 });
  }

  const user = await User.findById(outcome.userId).select("username kind email");
  if (!user) {
    // The account was deleted between the link being sent and used. The token is spent either way.
    return NextResponse.json({ error: REFUSALS.unknown }, { status: 400 });
  }
  // An account that became a machine identity after the link was issued must not be signed into
  if (user.kind === "machine") {
    return NextResponse.json({ error: REFUSALS.unknown }, { status: 400 });
  }

  // Every session, including whoever is signed in on the old password — which is the case somebody
  // resetting a password they believe was stolen is trying to end
  await revokeUserSessions(user._id);

  try {
    await User.updateOne({ _id: user._id }, { $set: { password: hashed } });
  } catch (err) {
    // The claim is one-shot, so a write that fails here would otherwise leave somebody signed out
    // of everything, holding a dead link, with their old password still in force and no way back
    await releaseResetToken(token).catch(() => {});
    throw err;
  }

  // Every other link too, and only once the password is safely written. Issuing is a delete
  // followed by a create, so two requests racing leave two live links; without this, resetting
  // with the second leaves the first able to set the password again, in an inbox the person may
  // not control.
  await invalidateResetTokens(user._id);

  void logInstanceAudit({
    action: "user_password_reset_by_email",
    user: user._id,
    target: user.username,
    // The address, because "was that me?" is the whole question this row exists to answer, and a
    // row saying only that it happened cannot answer it
    detail: clientIp ? `from ${clientIp}` : "from an unknown address",
  });

  // The other half of "was that me?": the audit row answers it for an administrator reading the
  // log, and this answers it for the person whose account it is.
  void notifyPasswordChanged({
    email: user.email,
    username: user.username,
    how: "reset_link",
    from: clientIp ? `from ${clientIp}` : "from an unknown address",
  });

  return NextResponse.json({ ok: true });
}
