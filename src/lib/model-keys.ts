import { NextResponse } from "next/server";
import type { ScopedDb } from "@/lib/db-scope";
import { decryptSecret } from "@/lib/encryption";
import { can, type Plan } from "@/lib/entitlements";
import { getOrganisation } from "@/lib/organisation";
import { organisationDomain } from "@/lib/organisation-host";

export type ModelProvider = "openrouter" | "openai";

const ENV_KEYS: Record<ModelProvider, () => string | undefined> = {
  openrouter: () => process.env.OPENROUTER_API_KEY || undefined,
  openai: () => process.env.OPENAI_API_KEY || process.env.OPENAPI_KEY || undefined,
};

export type ModelKeyRefusal = "needs_plan" | "not_configured" | "own_key_unreadable";

export type ModelKeyResult =
  | { ok: true; key: string; source: "own" | "instance" | "managed" }
  | { ok: false; reason: ModelKeyRefusal; plan: Plan };

/**
 * Which key a model call is made with, for one organisation. The organisation's own key always wins
 * and is never capped; ours is used only where the operator's environment is the customer's own
 * (self-hosted) or where the plan includes managed AI (Pro, and the trial, which is a Pro key). An
 * organisation that stored its own key never falls back to ours: a key that fails there fails, it is
 * not a way to spend the operator's money.
 */
export async function resolveModelKey(db: ScopedDb, provider: ModelProvider): Promise<ModelKeyResult> {
  const settings = await db.Settings.findOne({}, "openrouterKey openaiKey").lean();
  const stored = provider === "openrouter" ? settings?.openrouterKey : settings?.openaiKey;
  if (stored) {
    try {
      return { ok: true, key: decryptSecret(stored, db.organisation), source: "own" };
    } catch {
      return { ok: false, reason: "own_key_unreadable", plan: (await getOrganisation(db.organisation)).entitlements.plan };
    }
  }

  const instanceKey = ENV_KEYS[provider]();
  const hosted = organisationDomain() !== null;
  if (!hosted) {
    return instanceKey
      ? { ok: true, key: instanceKey, source: "instance" }
      : { ok: false, reason: "not_configured", plan: "free" };
  }

  const organisation = await getOrganisation(db.organisation);
  if (!instanceKey) return { ok: false, reason: "not_configured", plan: organisation.entitlements.plan };
  if (!can(organisation, "ai.managed")) {
    return { ok: false, reason: "needs_plan", plan: organisation.entitlements.plan };
  }
  return { ok: true, key: instanceKey, source: "managed" };
}

const OWN_KEY_OR_PRO =
  "On the Free plan the AI runs on your own key. Add one in Settings → AI keys, or upgrade to Pro.";

export type ModelKeyRefused = Extract<ModelKeyResult, { ok: false }>;

/** What a refusal says and which status carries it: 402 for the plan, so the UI can offer the key or the upgrade */
export function describeModelKeyRefusal(
  refusal: ModelKeyRefused,
  notConfigured: { error: string; status: number }
): { error: string; status: number } {
  if (refusal.reason === "needs_plan") return { error: OWN_KEY_OR_PRO, status: 402 };
  if (refusal.reason === "own_key_unreadable") {
    return { error: "The stored AI key cannot be read. Enter it again in Settings → AI keys.", status: 503 };
  }
  return notConfigured;
}

export function modelKeyRefusalResponse(
  refusal: ModelKeyRefused,
  notConfigured: { error: string; status: number }
): NextResponse {
  const { error, status } = describeModelKeyRefusal(refusal, notConfigured);
  return NextResponse.json(
    status === 402 ? { error, feature: "ai.managed", plan: refusal.plan } : { error },
    { status }
  );
}
