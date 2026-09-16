import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { getClientIp } from "@/lib/auth";
import { consumeEmailChange, releaseEmailChange } from "@/lib/email-change";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { duplicateKeyField } from "@/lib/mongo-errors";
import { invalidateResetTokens } from "@/lib/password-reset";
import { anonymousMultiplier, isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/request-body";
import { notifyAddressChanged } from "@/lib/security-mail";
import { provenanceRefusal } from "@/lib/session";
import { User } from "@/models/user";

const ATTEMPTS_PER_SOURCE = 20;

const REFUSALS: Record<string, string> = {
  unknown: "This link is not valid. Change the address again from your profile.",
  expired: "This link has expired. Change the address again from your profile.",
  used: "This link has already been used.",
};

// A POST from the page rather than the link itself: a mail scanner following every link in an
// inbox would otherwise confirm an address nobody there asked for (BP-359)
export async function POST(request: Request) {
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  const clientIp = getClientIp(request);
  const throttleKey = sourceKey(clientIp ?? "-", "email-confirm-use");
  if (await isRateLimited(throttleKey, anonymousMultiplier(clientIp, ATTEMPTS_PER_SOURCE))) {
    return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  }
  await recordFailedAttempt(throttleKey);

  const read = await readJsonBody<{ token?: unknown }>(request);
  if (!read.ok) return read.response;
  const { token } = read.value;
  if (typeof token !== "string" || !token) {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }

  await connectDB();
  const outcome = await consumeEmailChange(token);
  if (!outcome.ok) {
    return NextResponse.json({ error: REFUSALS[outcome.reason] }, { status: 400 });
  }

  const user = await User.findById(outcome.userId).select("username kind email");
  if (!user || user.kind === "machine") {
    return NextResponse.json({ error: REFUSALS.unknown }, { status: 400 });
  }
  const previousEmail = user.email ?? "";

  if (previousEmail !== outcome.email) {
    const taken = await User.exists({ email: outcome.email, _id: { $ne: user._id } });
    if (taken) {
      // Nothing changed, so the link stays good for when the address is free again
      await releaseEmailChange(token, outcome.claimedAt).catch(() => {});
      return NextResponse.json({ error: "That email is already on another account" }, { status: 409 });
    }
    try {
      await User.updateOne({ _id: user._id }, { $set: { email: outcome.email } });
    } catch (err) {
      await releaseEmailChange(token, outcome.claimedAt).catch(() => {});
      if (duplicateKeyField(err) === "email") {
        return NextResponse.json({ error: "That email is already on another account" }, { status: 409 });
      }
      throw err;
    }

    // A link already sent to the old inbox must not outlive the move away from it
    await invalidateResetTokens(user._id);

    void logInstanceAudit({
      action: "user_email_changed_self",
      user: user._id,
      actorUsername: user.username,
      target: user.username,
      detail: `${previousEmail || "none"} → ${outcome.email}`,
    });
    void notifyAddressChanged({ previousEmail, username: user.username, newEmail: outcome.email });
  }

  return NextResponse.json({ ok: true, email: outcome.email });
}
