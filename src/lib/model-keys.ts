import { NextResponse } from "next/server";
import type { Types } from "mongoose";
import type { ScopedDb } from "@/lib/db-scope";
import { decryptSecret } from "@/lib/encryption";
import { can, type Plan } from "@/lib/entitlements";
import { getOrganisation } from "@/lib/organisation";
import { organisationDomain } from "@/lib/organisation-host";

const instanceKeyOf = (): string | undefined => process.env.OPENROUTER_API_KEY || undefined;

export type ModelKeyRefusal = "needs_plan" | "not_configured" | "own_key_unreadable";

export type ModelKeyResult =
  | { ok: true; key: string; source: "own" | "instance" | "managed" }
  | { ok: false; reason: ModelKeyRefusal; plan: Plan };

/**
 * Which OpenRouter key a model call is made with, for one organisation. The PM agent and AI Assist
 * both run on it. The organisation's own key always wins,
 * and the plan's managed-AI allowance does not apply to it; ours is used only where the operator's
 * environment is the customer's own (self-hosted) or where the plan includes managed AI (Pro, and the
 * trial, which is a Pro key). An organisation that stored its own key never falls back to ours: a key
 * that fails there fails, it is not a way to spend the operator's money.
 */
export async function resolveModelKey(db: ScopedDb): Promise<ModelKeyResult> {
  const stored = (await db.Settings.findOne({}, "openrouterKey").lean())?.openrouterKey;
  if (stored) {
    try {
      return { ok: true, key: decryptSecret(stored, db.organisation), source: "own" };
    } catch {
      return { ok: false, reason: "own_key_unreadable", plan: (await getOrganisation(db.organisation)).entitlements.plan };
    }
  }

  const instanceKey = instanceKeyOf();
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

const MANAGED_PLAN_TTL_MS = 10_000;
const managedPlan = new Map<string, { at: number; entitled: boolean }>();

export function forgetManagedPlans(): void {
  managedPlan.clear();
}

async function entitledToManagedAi(organisation: Types.ObjectId): Promise<boolean> {
  const id = String(organisation);
  const seen = managedPlan.get(id);
  if (seen && Date.now() - seen.at < MANAGED_PLAN_TTL_MS) return seen.entitled;
  const entitled = can(await getOrganisation(organisation), "ai.managed");
  managedPlan.set(id, { at: Date.now(), entitled });
  return entitled;
}

export interface ModelKeyAvailability {
  available: boolean;
  needsPlan: boolean;
  unreadable: boolean;
}

/**
 * What the screens need to know about the key: whether a call would run, and if not, whether a
 * plan or a re-entered key would fix it. Asked on every board poll, so it costs one Settings read,
 * and the plan, which is the one thing that reads more, is remembered for a few seconds. A call
 * itself never goes through here: `resolveModelKey` asks the plan afresh.
 */
export async function modelKeyAvailability(db: ScopedDb): Promise<ModelKeyAvailability> {
  const stored = (await db.Settings.findOne({}, "openrouterKey").lean())?.openrouterKey;
  if (stored) {
    try {
      decryptSecret(stored, db.organisation);
      return { available: true, needsPlan: false, unreadable: false };
    } catch {
      return { available: false, needsPlan: false, unreadable: true };
    }
  }

  const hasInstanceKey = instanceKeyOf() !== undefined;
  if (organisationDomain() === null) return { available: hasInstanceKey, needsPlan: false, unreadable: false };
  if (!hasInstanceKey) return { available: false, needsPlan: false, unreadable: false };
  const entitled = await entitledToManagedAi(db.organisation);
  return { available: entitled, needsPlan: !entitled, unreadable: false };
}

const OWN_KEY_OR_PRO =
  "On the Free plan the AI runs on your own key. An administrator can add one in Settings → AI key, or upgrade to Pro.";

export type ModelKeyRefused = Extract<ModelKeyResult, { ok: false }>;

/** What a refusal says and which status carries it: 402 for the plan, so the UI can offer the key or the upgrade */
export function describeModelKeyRefusal(
  refusal: ModelKeyRefused,
  notConfigured: { error: string; status: number }
): { error: string; status: number } {
  if (refusal.reason === "needs_plan") return { error: OWN_KEY_OR_PRO, status: 402 };
  if (refusal.reason === "own_key_unreadable") {
    return { error: "The stored AI key cannot be read. Enter it again in Settings → AI key.", status: 503 };
  }
  // A hosted organisation cannot set an environment variable; the key it can add is its own
  if (organisationDomain() !== null) {
    return { error: "No AI key is available. Add your own in Settings → AI key.", status: notConfigured.status };
  }
  return notConfigured;
}

export function modelKeyRefusalResponse(
  refusal: ModelKeyRefused,
  notConfigured: { error: string; status: number }
): NextResponse {
  const { error, status } = describeModelKeyRefusal(refusal, notConfigured);
  return NextResponse.json(
    status === 402
      ? { error, reason: refusal.reason, feature: "ai.managed", plan: refusal.plan }
      : { error, reason: refusal.reason },
    { status }
  );
}
