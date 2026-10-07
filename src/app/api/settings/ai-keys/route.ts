import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import type { ScopedDb } from "@/lib/db-scope";
import { encryptSecret, isEncryptionConfigured } from "@/lib/encryption";
import { can } from "@/lib/entitlements";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { withAdmin } from "@/lib/middleware";
import { getOrganisation } from "@/lib/organisation";
import { organisationDomain } from "@/lib/organisation-host";
import { duplicateKeyField } from "@/lib/mongo-errors";

const MAX_KEY_LENGTH = 300;
const MIN_KEY_LENGTH = 8;
const PROVIDERS = [
  { name: "openrouter", field: "openrouterKey", hint: "openrouterKeyHint", env: () => !!process.env.OPENROUTER_API_KEY },
  {
    name: "openai",
    field: "openaiKey",
    hint: "openaiKeyHint",
    env: () => !!(process.env.OPENAI_API_KEY || process.env.OPENAPI_KEY),
  },
] as const;

type Provider = (typeof PROVIDERS)[number];

async function view(db: ScopedDb) {
  const [settings, organisation] = await Promise.all([
    db.Settings.findOne({}, "openrouterKey openrouterKeyHint openaiKey openaiKeyHint").lean(),
    getOrganisation(db.organisation),
  ]);
  const hosted = organisationDomain() !== null;
  const managed = !hosted || can(organisation, "ai.managed");
  return {
    hosted,
    plan: organisation.entitlements.plan,
    providers: Object.fromEntries(
      PROVIDERS.map((p) => [
        p.name,
        {
          set: !!settings?.[p.field],
          hint: settings?.[p.field] ? (settings[p.hint] ?? "") : "",
          // What the instance offers when the organisation stores nothing: its own key where
          // self-hosted, the operator's where the plan includes managed AI
          included: p.env() && managed,
        },
      ])
    ),
  };
}

export const GET = withAdmin(async (_request, { db }) => {
  await connectDB();
  return NextResponse.json(await view(db));
});

function validKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_KEY_LENGTH &&
    value.length <= MAX_KEY_LENGTH &&
    // eslint-disable-next-line no-control-regex
    !/[\s\u0000-\u001f\u007f]/.test(value)
  );
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

  const set: Record<string, string> = {};
  const unset: Record<string, 1> = {};
  const changed: string[] = [];
  for (const provider of PROVIDERS as readonly Provider[]) {
    const incoming = body[provider.field];
    if (incoming === undefined) continue;
    if (incoming === null || incoming === "") {
      unset[provider.field] = 1;
      unset[provider.hint] = 1;
      changed.push(`${provider.field}: removed`);
      continue;
    }
    if (!validKey(incoming)) {
      return NextResponse.json(
        { error: `${provider.field} must be ${MIN_KEY_LENGTH} to ${MAX_KEY_LENGTH} characters with no spaces` },
        { status: 400 }
      );
    }
    if (!isEncryptionConfigured()) {
      return NextResponse.json(
        { error: "ENCRYPTION_KEY is not configured on the server, so a key cannot be stored" },
        { status: 503 }
      );
    }
    set[provider.field] = encryptSecret(incoming, db.organisation);
    set[provider.hint] = incoming.slice(-4);
    changed.push(`${provider.field}: set`);
  }

  if (changed.length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const update = {
    ...(Object.keys(set).length ? { $set: set } : {}),
    ...(Object.keys(unset).length ? { $unset: unset } : {}),
  };
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
    detail: changed.join(", "),
  });

  return NextResponse.json(await view(db));
});
