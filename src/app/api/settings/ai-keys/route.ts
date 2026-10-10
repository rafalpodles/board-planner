import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import type { ScopedDb } from "@/lib/db-scope";
import { decryptSecret, encryptSecret, isEncryptionConfigured } from "@/lib/encryption";
import { aiUsageSummary } from "@/lib/ai-gateway/summary";
import { can } from "@/lib/entitlements";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { withAdmin } from "@/lib/middleware";
import { getOrganisation } from "@/lib/organisation";
import { organisationDomain } from "@/lib/organisation-host";
import { duplicateKeyField } from "@/lib/mongo-errors";

const MAX_KEY_LENGTH = 300;
// Long enough that the four characters shown afterwards are not half of it
const MIN_KEY_LENGTH = 20;
function readable(sealed: string, db: ScopedDb): boolean {
  try {
    decryptSecret(sealed, db.organisation);
    return true;
  } catch {
    return false;
  }
}

async function view(db: ScopedDb) {
  const [settings, organisation, usage] = await Promise.all([
    db.Settings.findOne({}, "openrouterKey openrouterKeyHint").lean(),
    getOrganisation(db.organisation),
    aiUsageSummary(db),
  ]);
  const hosted = organisationDomain() !== null;
  const managed = !hosted || can(organisation, "ai.managed");
  const stored = settings?.openrouterKey;
  return {
    hosted,
    plan: organisation.entitlements.plan,
    set: !!stored,
    hint: stored ? (settings.openrouterKeyHint ?? "") : "",
    // Stored, but sealed under a key this server no longer has: every call fails until it is entered again
    unreadable: !!stored && !readable(stored, db),
    // What the instance offers when the organisation stores nothing: its own key where self-hosted,
    // the operator's where the plan includes managed AI
    included: !!process.env.OPENROUTER_API_KEY && managed,
    usage,
  };
}

export const GET = withAdmin(async (_request, { db }) => {
  await connectDB();
  return NextResponse.json(await view(db));
});

// Printable ASCII only: a header cannot carry anything else, so a pasted zero-width space or an accent
// would be stored as a key that fails every call
function validKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= MIN_KEY_LENGTH && value.length <= MAX_KEY_LENGTH && /^[\x21-\x7e]+$/.test(value);
}

export const PUT = withAdmin(async (request, { user, db }) => {
  // A key is spent money: only a person at the screen sets one, never a token that holds one
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  }
  await connectDB();

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected an object" }, { status: 400 });
  }

  const incoming = body.openrouterKey;
  if (incoming === undefined) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  let update: Record<string, Record<string, unknown>>;
  let changed: string;
  if (incoming === null || incoming === "") {
    update = { $unset: { openrouterKey: 1, openrouterKeyHint: 1 } };
    changed = "openrouterKey: removed";
  } else {
    if (!validKey(incoming)) {
      return NextResponse.json(
        { error: `openrouterKey must be ${MIN_KEY_LENGTH} to ${MAX_KEY_LENGTH} printable characters with no spaces` },
        { status: 400 }
      );
    }
    if (!isEncryptionConfigured()) {
      return NextResponse.json(
        { error: "ENCRYPTION_KEY is not configured on the server, so a key cannot be stored" },
        { status: 503 }
      );
    }
    update = { $set: { openrouterKey: encryptSecret(incoming, db.organisation), openrouterKeyHint: incoming.slice(-4) } };
    changed = "openrouterKey: set";
  }

  const write = () => db.Settings.findOneAndUpdate({}, update, { upsert: true });
  try {
    await write();
  } catch (err) {
    // Two first writes of one organisation's settings race on the unique index; the loser retries
    if (duplicateKeyField(err) !== "organisation") throw err;
    await write();
  }

  // What changed, never the key: the log is read by every admin
  void logInstanceAudit(db, {
    action: "instance_settings_changed",
    user: user._id,
    actorUsername: user.username,
    detail: changed,
  });

  return NextResponse.json(await view(db));
});
