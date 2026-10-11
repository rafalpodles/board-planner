import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import type { ScopedDb } from "@/lib/db-scope";
import { can } from "@/lib/entitlements";
import { decryptSecret, encryptSecret, isEncryptionConfigured } from "@/lib/encryption";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { entitlementRefusal, withAdmin } from "@/lib/middleware";
import { discoverProvider, returnAddress } from "@/lib/oidc/flow";
import { parseSsoInput, SSO_LABEL_DEFAULT } from "@/lib/oidc/organisation-sso";
import { getOrganisation } from "@/lib/organisation";
import { organisationDomain, originFor } from "@/lib/organisation-host";
import { countInLiveWindow, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/request-body";
import { BlockedDestinationError } from "@/lib/safe-fetch";
import { duplicateKeyField } from "@/lib/mongo-errors";

// The OpenID client wraps what its fetch threw, so the refusal of an internal address is found down the cause chain
function isBlocked(error: unknown): boolean {
  for (let hop = 0, e = error; e && hop < 5; hop++, e = (e as { cause?: unknown }).cause) {
    if (e instanceof BlockedDestinationError) return true;
  }
  return false;
}

// Two first writes of one organisation's settings race on the unique index; the loser retries
async function writeSettings(db: ScopedDb, update: Record<string, Record<string, unknown>>) {
  const write = () => db.Settings.findOneAndUpdate({}, update, { upsert: true });
  try {
    await write();
  } catch (err) {
    if (duplicateKeyField(err) !== "organisation") throw err;
    await write();
  }
}

// Each save makes the server read an address the administrator typed, for up to a few seconds
const SAVES_PER_WINDOW = 10;

const CLOUD_ONLY = { error: "A sign-in provider of its own is set up per organisation in the cloud; here it comes from the environment" };

async function view(db: ScopedDb) {
  const [settings, organisation, origin] = await Promise.all([db.Settings.findOne({}, "sso").lean(), getOrganisation(db.organisation), originFor(db)]);
  const sso = settings?.sso;
  const available = can(organisation, "identity.sso");
  let unreadable = false;
  if (sso) {
    try {
      decryptSecret(sso.clientSecret, db.organisation);
    } catch {
      // Sealed under a key this server no longer has: the secret has to be entered again
      unreadable = true;
    }
  }
  const trial = organisation.entitlements.trial === true;
  return {
    hosted: true,
    plan: organisation.entitlements.plan,
    trial,
    trialEndsAt: trial && organisation.entitlements.expiresAt ? new Date(organisation.entitlements.expiresAt).toISOString() : null,
    available,
    set: !!sso,
    issuer: sso?.issuer ?? "",
    clientId: sso?.clientId ?? "",
    label: sso?.label ?? SSO_LABEL_DEFAULT,
    secretHint: sso?.clientSecretHint ?? "",
    unreadable,
    // Offered at sign-in right now: stored, readable, and the plan includes it
    active: !!sso && available && !unreadable,
    redirectUri: origin ? returnAddress({ id: "oidc" }, origin) : null,
  };
}

export const GET = withAdmin(async (_request, { db }) => {
  if (organisationDomain() === null) return NextResponse.json({ hosted: false });
  await connectDB();
  return NextResponse.json(await view(db));
});

export const PUT = withAdmin(async (request, { user, db }) => {
  // A way into every account is set by a person at the screen, never by a token that holds one
  if (user.viaMachineCredential) return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  if (organisationDomain() === null) return NextResponse.json(CLOUD_ONLY, { status: 404 });
  await connectDB();
  const refusal = await entitlementRefusal(db, "identity.sso");
  if (refusal) return refusal;

  const throttleKey = sourceKey(String(db.organisation), "sso-save");
  // Counted first and compared after, so a burst of parallel saves each finds its own place in the count
  await recordFailedAttempt(throttleKey);
  if ((await countInLiveWindow(throttleKey)) > SAVES_PER_WINDOW) {
    return NextResponse.json({ error: "Too many saves. Try again in 15 minutes." }, { status: 429 });
  }

  const read = await readJsonBody<unknown>(request);
  if (!read.ok) return read.response;
  const parsed = parseSsoInput(read.value);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { issuer, clientId, label } = parsed.value;
  if (!isEncryptionConfigured()) {
    return NextResponse.json({ error: "ENCRYPTION_KEY is not configured on the server, so a secret cannot be stored" }, { status: 503 });
  }

  const stored = (await db.Settings.findOne({}, "sso").lean())?.sso;
  let secret = parsed.value.clientSecret;
  if (!secret) {
    // The stored secret belongs to the issuer and client it was given for: it is never sent to another
    if (!stored || stored.issuer !== issuer || stored.clientId !== clientId) {
      return NextResponse.json({ error: "Enter the client secret: it is asked for again whenever the issuer or the client ID changes" }, { status: 400 });
    }
    try {
      secret = decryptSecret(stored.clientSecret, db.organisation);
    } catch {
      return NextResponse.json({ error: "The stored client secret can no longer be read. Enter it again." }, { status: 400 });
    }
  }

  try {
    await discoverProvider({ id: "oidc", kind: "oidc", linksByAddress: true, label, issuer, clientId, clientSecret: secret, own: true });
  } catch (err) {
    if (isBlocked(err)) {
      return NextResponse.json({ error: "That address is not one this server may call. Use the public address of your provider." }, { status: 400 });
    }
    return NextResponse.json({ error: "Could not read the provider's discovery document. Check the issuer address, it must serve /.well-known/openid-configuration." }, { status: 400 });
  }

  await writeSettings(db, { $set: { sso: { issuer, clientId, clientSecret: encryptSecret(secret, db.organisation), clientSecretHint: secret.slice(-4), label } } });
  // What changed, never the secret: the log is read by every admin
  void logInstanceAudit(db, {
    action: "instance_settings_changed",
    user: user._id,
    actorUsername: user.username,
    detail: `single sign-on: set (${issuer}, client ${clientId})`,
  });
  return NextResponse.json(await view(db));
});

export const DELETE = withAdmin(async (_request, { user, db }) => {
  if (user.viaMachineCredential) return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  if (organisationDomain() === null) return NextResponse.json(CLOUD_ONLY, { status: 404 });
  await connectDB();
  await writeSettings(db, { $unset: { sso: 1 } });
  void logInstanceAudit(db, { action: "instance_settings_changed", user: user._id, actorUsername: user.username, detail: "single sign-on: removed" });
  return NextResponse.json(await view(db));
});
