import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/db";
import { MIN_PASSWORD_LENGTH, PASSWORD_COST_FACTOR } from "@/lib/auth";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { consumeResetToken } from "@/lib/password-reset";
import { provenanceRefusal, revokeUserSessions } from "@/lib/session";
import { User } from "@/models/user";

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

  await connectDB();

  const outcome = await consumeResetToken(token);
  if (!outcome.ok) {
    return NextResponse.json({ error: REFUSALS[outcome.reason] }, { status: 400 });
  }

  const user = await User.findById(outcome.userId).select("username kind");
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

  await User.updateOne(
    { _id: user._id },
    { $set: { password: await bcrypt.hash(newPassword, PASSWORD_COST_FACTOR) } }
  );

  void logInstanceAudit({
    action: "password_reset_completed",
    user: user._id,
    target: user.username,
  });

  return NextResponse.json({ ok: true });
}
