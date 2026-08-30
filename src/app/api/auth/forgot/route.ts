import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/request-body";
import { connectDB } from "@/lib/db";
import { getClientIp } from "@/lib/auth";
import { APP_NAME } from "@/lib/brand";
import { isEmailConfigured, normaliseEmail, sendEmail } from "@/lib/email";
import { renderEmail } from "@/lib/email-template";
import { issueResetToken } from "@/lib/password-reset";
import {
  anonymousMultiplier,
  isRateLimited,
  normaliseUsername,
  recordFailedAttempt,
  sourceKey,
} from "@/lib/rate-limit";
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

  const read = await readJsonBody<{ identifier?: unknown }>(request);
  if (!read.ok) return read.response;
  const body = read.value;

  const { identifier } = body;
  if (typeof identifier !== "string" || !identifier.trim()) {
    return NextResponse.json({ error: "Enter your username or email address" }, { status: 400 });
  }

  // Said plainly, and it is not a leak: this is a fact about the deployment, not about any
  // account. An instance with no mail server cannot do this at all, and a person left staring at
  // "a link is on its way" would wait for something that was never coming.
  if (!isEmailConfigured()) {
    return NextResponse.json(
      { error: "This instance cannot send email. Ask an administrator to set a password for you." },
      { status: 503 }
    );
  }

  const origin = selfOrigin();
  if (!origin) {
    console.error("Password reset requested with no PUBLIC_ORIGIN configured");
    return NextResponse.json(
      {
        error:
          "This instance does not know its own address (PUBLIC_ORIGIN), so it cannot build a link. Ask an administrator.",
      },
      { status: 500 }
    );
  }

  const clientIp = getClientIp(request);
  const throttleKey = sourceKey(clientIp ?? "-", "password-reset");
  // anonymousMultiplier, because with no trusted proxy configured getClientIp returns null and
  // every caller on earth shares the key "-". A flat ceiling there is not a per-address limit at
  // all: eleven requests from one attacker would close password reset for everybody, which is a
  // lever an idle attacker can hold down. The registration and enrolment routes already do this.
  if (await isRateLimited(throttleKey, anonymousMultiplier(clientIp, REQUESTS_PER_SOURCE))) {
    return NextResponse.json(
      { error: "Too many requests. Try again in 15 minutes." },
      { status: 429 }
    );
  }
  // Counted on every request, not only the ones that find an account: counting failures alone
  // would leave the cheap path unmetered and time the difference for the caller.
  await recordFailedAttempt(throttleKey);

  await connectDB();

  const typed = identifier.trim();
  // Either half of what a person remembers, but asked as two questions in a fixed order rather
  // than one $or. Nothing stops an account being named `bob@corp.com` while a different account
  // holds that as its address, and with $or which of the two matched is a query-planner detail —
  // so Bob types his own address and the link goes to the other account's inbox.
  const humans = { kind: { $ne: "machine" } };
  const fields = "_id username email fullName";
  // Both lookups, always, and in parallel: doing the second only when the first misses makes the
  // miss path measurably slower than the hit path, which is the same oracle read backwards.
  const [byEmail, byUsername] = await Promise.all([
    User.findOne({ ...humans, email: normaliseEmail(typed) }).select(fields),
    User.findOne({ ...humans, username: normaliseUsername(typed) }).select(fields),
  ]);
  // Address wins: nothing stops an account being named `bob@corp.com` while a different account
  // holds that as its address, and letting the planter decide would send Bob's link elsewhere.
  const user = byEmail ?? byUsername;

  if (user?.email) {
    // Everything from here is kicked off without being awaited, so the reply leaves at the same
    // moment on every path. Issuing writes two rows and sending opens an SMTP connection; awaiting
    // either times the difference between "no such account" and "account exists" for anybody who
    // cares to measure, which is the oracle the uniform answer above exists to close.
    void deliverLink(user, origin);
  }

  return NextResponse.json(UNIFORM_ANSWER);
}

async function deliverLink(
  user: { _id: unknown; username: string; email: string },
  origin: string
): Promise<void> {
  try {
    const token = await issueResetToken(user._id as Parameters<typeof issueResetToken>[0]);
    const link = `${origin}/reset?token=${encodeURIComponent(token)}`;
    const { html, text } = renderEmail({
      preheader: `The link works once and expires in an hour.`,
      kicker: "Password reset",
      heading: `Set a new password for ${user.username}`,
      intro: [
        "Somebody asked to reset the password for this account. The link below works once and expires an hour after it was sent.",
      ],
      button: { label: "Choose a new password", url: link },
      showButtonUrl: true,
      outro: [
        "If it wasn't you, nothing has changed and you can ignore this message. Your current password still works.",
      ],
      footer: [
        `Sent because a reset was requested for ${user.username}.`,
        "This is the only email in this thread — we won't send a reminder.",
      ],
    });
    const sent = await sendEmail({
      to: user.email,
      subject: `Reset your ${APP_NAME} password`,
      text,
      html,
    });
    if (!sent) console.error(`Password reset email could not be sent for ${user.username}`);
  } catch (err) {
    // Nobody is waiting on this any more, so an unhandled rejection here would take the process
    // down over a mail server having a bad afternoon
    console.error("Password reset delivery failed:", err);
  }
}
