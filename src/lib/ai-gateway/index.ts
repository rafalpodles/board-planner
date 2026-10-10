import type { ScopedDb } from "@/lib/db-scope";
import { modelKeyRefusalBody, resolveModelKey } from "@/lib/model-keys";
import { chatCompletion, platformProviderPreferences, type OrCompletionResult, type OrUsage } from "@/lib/pm/openrouter";
import { checkBudget, counterKindOf } from "./budget";
import { getOrganisation } from "@/lib/organisation";
import { describeAiLock, describeBudgetRefusal } from "./refusal";
import { recordUsage, type UsageEntry } from "./usage";

const CHARACTERS_PER_TOKEN = 4;
const TOKENS_PER_IMAGE = 1500;
const IMAGE_DATA_URI = /^data:image\/[^;,]+;base64,/;

/** What was sent, as far as it is known: its text, and a flat figure for each image, which travels as base64 and is billed by its size on screen */
function sentTokens(messages: unknown): number {
  let images = 0;
  const text = JSON.stringify(messages, (_key, value) => {
    if (typeof value === "string" && IMAGE_DATA_URI.test(value)) {
      images++;
      return "";
    }
    return value;
  });
  return Math.ceil(text.length / CHARACTERS_PER_TOKEN) + images * TOKENS_PER_IMAGE;
}

export type GatewayContext = Pick<UsageEntry, "source" | "projectId" | "userId">;

export type OpenGate = { ok: true; key: string; keySource: UsageEntry["keySource"]; counter: "trial" | "month" };
export type ClosedGate = { ok: false; status: number; error: string; body: Record<string, unknown> };

/**
 * The one door to a model. It finds the key the call is made with, and refuses it where the organisation may not use the
 * operator's: no plan for it, the operator has switched it off for the organisation, or what it was allowed to spend is spent. An organisation's own key is never refused for
 * that, and is counted all the same.
 */
export async function openGate(db: ScopedDb, notConfigured: { error: string; status: number }): Promise<OpenGate | ClosedGate> {
  const modelKey = await resolveModelKey(db);
  if (!modelKey.ok) {
    const { body, status } = modelKeyRefusalBody(modelKey, notConfigured);
    return { ok: false, status, error: String(body.error), body };
  }
  if (modelKey.source === "own") return { ok: true, key: modelKey.key, keySource: "own", counter: await counterKindOf(db) };

  if (modelKey.source === "managed") {
    const { aiLockedAt, aiLockedReason } = await getOrganisation(db.organisation);
    if (aiLockedAt) {
      const error = describeAiLock(aiLockedReason ?? "");
      return { ok: false, status: 403, error, body: { error, reason: "ai_locked" } };
    }
  }

  const { refusal, counter } = await checkBudget(db);
  if (refusal) {
    const error = describeBudgetRefusal(refusal);
    return {
      ok: false,
      status: 429,
      error,
      body: { error, reason: "ai_budget", scope: refusal.scope, used: refusal.used, limit: refusal.limit, resetsAt: refusal.resetsAt?.toISOString() ?? null },
    };
  }
  return { ok: true, key: modelKey.key, keySource: modelKey.source, counter };
}

async function record(db: ScopedDb, entry: UsageEntry, counter: OpenGate["counter"]): Promise<void> {
  // The call was made and answered: failing to write it down must not take the answer with it
  try {
    await recordUsage(db, entry, counter);
  } catch (error) {
    console.error("Recording AI usage failed:", error instanceof Error ? error.message : error);
  }
}

/** One round-trip of the PM agent: refused before it is made when the organisation may not spend, and counted after it is answered */
export async function gatewayChat(
  db: ScopedDb,
  context: GatewayContext,
  opts: Omit<Parameters<typeof chatCompletion>[0], "apiKey">
): Promise<OrCompletionResult> {
  const gate = await openGate(db, { error: "The PM agent is not configured on this instance", status: 503 });
  if (!gate.ok) return { type: "error", error: gate.error };

  // Stopped while the gate was being opened: nothing was sent, so nothing is counted
  if (opts.signal?.aborted) return { type: "aborted" };

  const completion = await chatCompletion({
    ...opts,
    apiKey: gate.key,
    ...(gate.keySource === "managed" ? { provider: platformProviderPreferences(opts.model) } : {}),
  });
  if (completion.type === "text" || completion.type === "tool_calls") {
    await record(db, { ...context, keySource: gate.keySource, model: opts.model, usage: completion.usage }, gate.counter);
  } else if (completion.type === "aborted") {
    // A request that reached the provider is billed whether or not anyone waited for the answer
    const sent = sentTokens(opts.messages);
    const usage = { promptTokens: sent, completionTokens: 0, totalTokens: sent, cachedPromptTokens: 0, cacheWriteTokens: 0 };
    await record(db, { ...context, keySource: gate.keySource, model: opts.model, usage }, gate.counter);
  }
  return completion;
}

/**
 * An AI Assist generation, made with the key a gate opened. The call says what the provider reported as soon as it has it,
 * so a generation that was answered and then judged unusable is still counted: it was billed.
 */
export async function gatewayAssist<T>(
  db: ScopedDb,
  context: GatewayContext,
  gate: OpenGate,
  model: string,
  call: (apiKey: string, report: (usage: OrUsage | undefined) => void, onPlatformKey: boolean) => Promise<T>
): Promise<T> {
  let answered: { usage?: OrUsage } | null = null;
  try {
    return await call(gate.key, (usage) => (answered = { usage }), gate.keySource === "managed");
  } finally {
    if (answered) await record(db, { ...context, keySource: gate.keySource, model, usage: (answered as { usage?: OrUsage }).usage }, gate.counter);
  }
}
