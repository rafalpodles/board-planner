import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { decryptSecret, encryptSecret, isEncryptionConfigured } from "@/lib/encryption";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { entitlementRefusal, withAdmin } from "@/lib/middleware";
import { organisationDomain } from "@/lib/organisation-host";
import { forgetMailRoute, ownMailTransport } from "@/lib/organisation-smtp";
import { countInLiveWindow, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/request-body";
import { BlockedDestinationError } from "@/lib/safe-fetch";
import { writeSettings } from "@/lib/settings-write";
import { parseSmtpInput } from "@/lib/smtp-input";
import { mailServerAnswer } from "@/lib/smtp-transport";
import { smtpView } from "@/lib/smtp-view";

// Each save makes the server connect to an address the administrator typed, for up to half a minute
const SAVES_PER_WINDOW = 10;

const CLOUD_ONLY = { error: "A mail server of its own is set per organisation in the cloud; here it comes from the environment" };

export const GET = withAdmin(async (_request, { db }) => {
  if (organisationDomain() === null) return NextResponse.json({ hosted: false });
  await connectDB();
  return NextResponse.json(await smtpView(db));
});

export const PUT = withAdmin(async (request, { user, db }) => {
  if (user.viaMachineCredential) return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  if (organisationDomain() === null) return NextResponse.json(CLOUD_ONLY, { status: 404 });
  await connectDB();
  const refusal = await entitlementRefusal(db, "email.smtp");
  if (refusal) return refusal;

  const throttleKey = sourceKey(String(db.organisation), "smtp-save");
  // Counted first and compared after, so a burst of parallel saves each finds its own place in the count
  await recordFailedAttempt(throttleKey);
  if ((await countInLiveWindow(throttleKey)) > SAVES_PER_WINDOW) {
    return NextResponse.json({ error: "Too many saves. Try again in 15 minutes." }, { status: 429 });
  }

  const read = await readJsonBody<unknown>(request);
  if (!read.ok) return read.response;
  const parsed = parseSmtpInput(read.value);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { host, port, user: login, fromAddress, fromName } = parsed.value;
  if (!isEncryptionConfigured()) {
    return NextResponse.json({ error: "ENCRYPTION_KEY is not configured on the server, so a password cannot be stored" }, { status: 503 });
  }

  const stored = (await db.Settings.findOne({}, "smtp").lean())?.smtp;
  let password = parsed.value.password;
  if (!password) {
    // A stored password belongs to the server and login it was given for: it is never sent to another
    if (!stored || stored.host !== host || stored.port !== port || stored.user !== login) {
      return NextResponse.json({ error: "Enter the password: it is asked for again whenever the host, port or username changes" }, { status: 400 });
    }
    try {
      password = decryptSecret(stored.password, db.organisation);
    } catch {
      return NextResponse.json({ error: "The stored password can no longer be read. Enter it again." }, { status: 400 });
    }
  }

  try {
    const transport = await ownMailTransport({ host, port, user: login, password, fromAddress, fromName });
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
  } catch (err) {
    if (err instanceof BlockedDestinationError) {
      return NextResponse.json({ error: "That address is not one this server may call. Use the public address of your mail server." }, { status: 400 });
    }
    return NextResponse.json({ error: `Your mail server did not accept the connection: ${mailServerAnswer(err)}` }, { status: 400 });
  }

  await writeSettings(db, {
    $set: { smtp: { host, port, user: login, password: encryptSecret(password, db.organisation), fromAddress, fromName } },
  });
  forgetMailRoute(db.organisation);
  void logInstanceAudit(db, {
    action: "instance_settings_changed",
    user: user._id,
    actorUsername: user.username,
    detail: `own mail server: set (${host}:${port}, user ${login}, from ${fromAddress})`,
  });
  return NextResponse.json(await smtpView(db));
});

export const DELETE = withAdmin(async (_request, { user, db }) => {
  if (user.viaMachineCredential) return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  if (organisationDomain() === null) return NextResponse.json(CLOUD_ONLY, { status: 404 });
  await connectDB();
  await writeSettings(db, { $unset: { smtp: 1 } });
  forgetMailRoute(db.organisation);
  void logInstanceAudit(db, { action: "instance_settings_changed", user: user._id, actorUsername: user.username, detail: "own mail server: removed" });
  return NextResponse.json(await smtpView(db));
});
