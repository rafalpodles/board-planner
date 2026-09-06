import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { EmailNotConfiguredError, emailSettingsSummary, sendEmailOrThrow } from "@/lib/email";
import { renderEmail } from "@/lib/email-template";
import { withAdmin } from "@/lib/middleware";
import { selfOrigin } from "@/lib/session";
import { APP_NAME } from "@/lib/brand";
import { User } from "@/models/user";

function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : "The mail server refused the message";
  return message.split("\n")[0].slice(0, 200);
}

export const GET = withAdmin(async (_request, { user }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  }

  return NextResponse.json(emailSettingsSummary());
});

export const POST = withAdmin(async (_request, { user }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  }

  await connectDB();
  const admin = await User.findById(user._id).select("email username");
  const to = admin?.email;
  if (!to) {
    return NextResponse.json(
      { error: "Add an address to your own profile first — the test goes there and nowhere else" },
      { status: 400 }
    );
  }

  const settings = emailSettingsSummary();
  const { html, text } = renderEmail({
    preheader: `Delivery works from ${settings.host || "this deployment"}.`,
    kicker: "Delivery test",
    heading: "Your mail server accepted this message",
    alert: {
      tone: "success",
      lines: [
        "If you're reading this, notifications and password resets can leave this deployment.",
      ],
    },
    rows: [
      { label: "Host", value: `${settings.host}:${settings.port}` },
      { label: "From", value: settings.from },
      { label: "Requested by", value: `${admin?.username ?? ""} · ${new Date().toUTCString()}` },
      { label: "Instance", value: selfOrigin() ?? "not configured" },
    ],
    footer: [
      "Sent because an administrator ran the delivery test. It goes to the requester's own address and nowhere else.",
    ],
  });

  try {
    await sendEmailOrThrow({
      to,
      subject: `${APP_NAME} test message`,
      text,
      html,
    });
  } catch (err) {
    if (err instanceof EmailNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("Test email failed:", err);
    return NextResponse.json(
      { error: firstLine(err) },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, to });
});
