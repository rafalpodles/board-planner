import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { EmailNotConfiguredError, emailSettingsSummary, sendEmailOrThrow } from "@/lib/email";
import { renderEmail } from "@/lib/email-template";
import { withAdmin } from "@/lib/middleware";
import { originFor } from "@/lib/organisation-host";
import { APP_NAME } from "@/lib/brand";
import { countAttempt, sourceKey } from "@/lib/rate-limit";
import { ownMailServerFor } from "@/lib/organisation-smtp";
import { BlockedDestinationError } from "@/lib/safe-fetch";
import { mailServerAnswer } from "@/lib/smtp-transport";

const TESTS_PER_WINDOW = 5;

export const GET = withAdmin(async (_request, { user, db }) => {
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
export const POST = withAdmin(async (_request, { user, db }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  }

  if ((await countAttempt(sourceKey(String(user._id), "email-test"))) > TESTS_PER_WINDOW) {
    return NextResponse.json({ error: "Too many test messages. Try again in 15 minutes." }, { status: 429 });
  }

  await connectDB();
  const admin = await db.User.findById(user._id).select("email username");
  const to = admin?.email;
  if (!to) {
    return NextResponse.json(
      { error: "Add an address to your own profile first — the test goes there and nowhere else" },
      { status: 400 }
    );
  }

  const settings = emailSettingsSummary();
  const own = await ownMailServerFor(db.organisation);
  const host = own ? `${own.host}:${own.port}` : !settings.managedByPlatform ? `${settings.host}:${settings.port}` : null;
  const { html, text } = renderEmail({
    preheader: `Delivery works from ${(own?.host ?? (!settings.managedByPlatform && settings.host)) || "this deployment"}.`,
    kicker: "Delivery test",
    heading: "Your mail server accepted this message",
    alert: {
      tone: "success",
      lines: [
        "If you're reading this, notifications and password resets can leave this deployment.",
      ],
    },
    rows: [
      ...(host ? [{ label: "Host", value: host }] : []),
      { label: "From", value: own ? own.fromAddress : settings.from },
      { label: "Requested by", value: `${admin?.username ?? ""} · ${new Date().toUTCString()}` },
      { label: "Instance", value: (await originFor(db)) ?? "not configured" },
    ],
    footer: [
      "Sent because an administrator ran the delivery test. It goes to the requester's own address and nowhere else.",
    ],
  });

  try {
    await sendEmailOrThrow({
      sender: db.organisation,
      to,
      subject: `${APP_NAME} test message`,
      text,
      html,
    });
  } catch (err) {
    // Nothing was contacted, so this is not the mail server's answer. The screen reads the status
    // to decide which of the two it says, and 502 here would blame a server that never heard us.
    if (err instanceof EmailNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof BlockedDestinationError) {
      return NextResponse.json({ error: "Your mail server's address cannot be used right now: it does not resolve, or it is inside the service's own network." }, { status: 409 });
    }
    // The whole point of the endpoint: what the mail server actually said. Everywhere else this
    // is swallowed, which is why a misconfigured deployment looks exactly like a working one.
    // Trimmed, because a server rejecting AUTH sometimes echoes the offending command back — and
    // that command carries SMTP_PASS, which this screen deliberately never shows.
    console.error("Test email failed:", err);
    return NextResponse.json(
      // The server's own words name its host, address or login, which on a shared instance are the platform's
      { error: settings.managedByPlatform && !own ? "The service's mail server did not accept the message." : mailServerAnswer(err) },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, to });
});
