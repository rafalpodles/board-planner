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

const UNIFORM_ANSWER = {
  message: "If that account exists and has an email address, a link is on its way.",
};

const REQUESTS_PER_SOURCE = 10;

export async function POST(request: Request) {
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  const clientIp = getClientIp(request);
  const throttleKey = sourceKey(clientIp ?? "-", "password-reset");
  if (await isRateLimited(throttleKey, anonymousMultiplier(clientIp, REQUESTS_PER_SOURCE))) {
    return NextResponse.json(
      { error: "Too many requests. Try again in 15 minutes." },
      { status: 429 }
    );
  }
  await recordFailedAttempt(throttleKey);

  const read = await readJsonBody<{ identifier?: unknown }>(request);
  if (!read.ok) return read.response;
  const body = read.value;

  const { identifier } = body;
  if (typeof identifier !== "string" || !identifier.trim()) {
    return NextResponse.json({ error: "Enter your username or email address" }, { status: 400 });
  }

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

  await connectDB();

  const typed = identifier.trim();
  const humans = { kind: { $ne: "machine" } };
  const fields = "_id username email fullName";
  const [byEmail, byUsername] = await Promise.all([
    User.findOne({ ...humans, email: normaliseEmail(typed) }).select(fields),
    User.findOne({ ...humans, username: normaliseUsername(typed) }).select(fields),
  ]);
  const user = byEmail ?? byUsername;

  if (user?.email) {
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
    console.error("Password reset delivery failed:", err);
  }
}
