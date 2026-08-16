import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { emailSettingsSummary, sendEmailOrThrow } from "@/lib/email";
import { withAdmin } from "@/lib/middleware";
import { APP_NAME } from "@/lib/brand";
import { User } from "@/models/user";

export const GET = withAdmin(async (_request, { user }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  }

  return NextResponse.json(emailSettingsSummary());
});

/**
 * Sends to the requesting admin's own address and nowhere else. A field for the recipient would
 * turn an authenticated instance into a mailer for arbitrary addresses, and the question this
 * answers — does mail leave this deployment — needs no such field.
 */
export const POST = withAdmin(async (_request, { user }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  }

  await connectDB();
  const admin = await User.findById(user._id).select("email");
  const to = admin?.email;
  if (!to) {
    return NextResponse.json(
      { error: "Add an address to your own profile first — the test goes there and nowhere else" },
      { status: 400 }
    );
  }

  try {
    await sendEmailOrThrow({
      to,
      subject: `${APP_NAME} test message`,
      text: `Your mail server accepted a message from ${APP_NAME}. Password reset emails will reach this address.`,
    });
  } catch (err) {
    // The whole point of the endpoint: what the mail server actually said. Everywhere else this
    // is swallowed, which is why a misconfigured deployment looks exactly like a working one.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "The mail server refused the message" },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, to });
});
