import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { getClientIp } from "@/lib/auth";
import { APP_NAME } from "@/lib/brand";
import { isEmailConfigured, normaliseEmail, sendEmail } from "@/lib/email";
import { issueResetToken } from "@/lib/password-reset";
import { isRateLimited, normaliseUsername, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import { provenanceRefusal, selfOrigin } from "@/lib/session";
import { User } from "@/models/user";

// One answer for every outcome: account found, no such account, account with no address, machine
// account. Anything else turns this endpoint into a way to ask "does rafal have an account here",
// and a login screen that refuses to say so is pointless if the reset form will.
const UNIFORM_ANSWER = {
  message: "If that account exists and has an email address, a link is on its way.",
};

// Sending mail is the expensive part, and the address it goes to is not chosen by the sender — so
// the limit is per source, to stop one caller filling somebody's inbox or burning the instance's
// sending reputation, rather than per account.
const REQUESTS_PER_SOURCE = 10;

export async function POST(request: Request) {
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  let body: { identifier?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { identifier } = body;
  if (typeof identifier !== "string" || !identifier.trim()) {
    return NextResponse.json({ error: "Enter your username or email address" }, { status: 400 });
  }

  // Said plainly, and it is not a leak: this is a fact about the deployment, not about any
  // account. An instance with no mail server cannot do this at all, and a person left staring at
  // "a link is on its way" would wait for something that was never coming.
  if (!isEmailConfigured()) {
    return NextResponse.json(
      {
        error:
          "This instance cannot send email, so it cannot reset a password this way. Ask an administrator to set one for you.",
      },
      { status: 503 }
    );
  }

  const origin = selfOrigin();
  if (!origin) {
    console.error("Password reset requested with no PUBLIC_ORIGIN configured");
    return NextResponse.json(
      { error: "This instance is not configured to send links to itself. Ask an administrator." },
      { status: 500 }
    );
  }

  const clientIp = getClientIp(request);
  const throttleKey = sourceKey(clientIp ?? "-", "password-reset");
  if (await isRateLimited(throttleKey, REQUESTS_PER_SOURCE)) {
    return NextResponse.json(
      { error: "Too many requests. Try again later." },
      { status: 429 }
    );
  }
  // Counted on every request, not only the ones that find an account: counting failures alone
  // would leave the cheap path unmetered and time the difference for the caller.
  await recordFailedAttempt(throttleKey);

  await connectDB();

  const typed = identifier.trim();
  // Either half of what a person remembers. Both are unique, and answering identically for both
  // means neither says whether the other exists.
  const user = await User.findOne({
    kind: { $ne: "machine" },
    $or: [{ username: normaliseUsername(typed) }, { email: normaliseEmail(typed) }],
  }).select("_id username email fullName");

  if (user?.email) {
    const token = await issueResetToken(user._id);
    const link = `${origin}/reset?token=${encodeURIComponent(token)}`;
    // Awaited so a mail server that refuses does not leave the caller told a link is coming, but
    // the answer is the same either way — the failure belongs in the log, not in a reply that
    // would tell an unauthenticated caller whether the address exists.
    const sent = await sendEmail({
      to: user.email,
      subject: `Reset your ${APP_NAME} password`,
      text: [
        `Somebody asked to reset the password for ${user.username}.`,
        "",
        `Open this link within the hour: ${link}`,
        "",
        "If it was not you, nothing has changed and you can ignore this message.",
      ].join("\n"),
    });
    if (!sent) console.error(`Password reset email could not be sent for ${user.username}`);
  }

  return NextResponse.json(UNIFORM_ANSWER);
}
