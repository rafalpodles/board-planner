import { createHash } from "crypto";
import type { OrChatMessage } from "./openrouter";

/**
 * Prompt caching across the round-trips of one turn (BP-568).
 *
 * A turn is up to MAX_STEPS calls and the front of every request is byte-identical across all of
 * them — the tool definitions, the system prompt and the replayed history. Whether that prefix is
 * billed once or fifteen times is the provider's decision, and providers split two ways: OpenAI,
 * DeepSeek, Grok, Moonshot, Groq, Z.AI and Gemini 2.5 cache automatically, while Anthropic and
 * Alibaba Qwen cache only what a `cache_control` breakpoint marks.
 *
 * So the breakpoints are sent to the second group only. They are not free to send to the first:
 * marking a block means rewriting a string `content` into an array of parts, and a request shape
 * changed for a provider that ignores the marking is a change with no upside.
 *
 * **Gemini is deliberately not marked, though it accepts breakpoints.** Gemini 2.5 and newer cache
 * implicitly, with no write and no storage charge; marking the same prefix moves it onto the
 * explicit path, which OpenRouter prices at the input rate *plus* five minutes of cache storage.
 * That is paying for what was already free. Matching only the older models instead would mean a
 * regex meaning "before 2.5", which every later release makes wrong in the expensive direction.
 */

/**
 * Matched against the model id as OpenRouter spells it. Deliberately narrow — a model absent from
 * this list is assumed to cache automatically, which is the safe way round: a missed breakpoint
 * costs a prefix re-billed at full price, while a breakpoint sent where caching already happens
 * costs a rewritten request and, on Gemini, a storage fee for a cache that was free.
 */
const EXPLICIT_BREAKPOINT_MODELS = [/^anthropic\//i, /^qwen\//i];

const CACHE_CONTROL = { type: "ephemeral" } as const;

export function needsCacheBreakpoints(model: string): boolean {
  return EXPLICIT_BREAKPOINT_MODELS.some((family) => family.test(model.trim()));
}

function marked(message: OrChatMessage): OrChatMessage {
  const content = message.content;

  if (typeof content === "string") {
    // An empty string is not a cacheable block, and wrapping it would send an empty text part
    if (!content.trim()) return message;
    return { ...message, content: [{ type: "text", text: content, cache_control: { ...CACHE_CONTROL } }] };
  }

  if (!Array.isArray(content) || content.length === 0) return message;
  const last = content.length - 1;
  return {
    ...message,
    content: content.map((part, i) => (i === last ? { ...part, cache_control: { ...CACHE_CONTROL } } : part)),
  };
}

/**
 * Up to two breakpoints. The first marks the system prompt; the second marks the end of
 * `prefixLength`, and a thread with nothing to replay yet has only the first. Anthropic permits
 * four.
 *
 * **`prefixLength` must name only what outlives this turn.** A cache write costs more than the
 * cold prompt it replaces — 1.25x base on Anthropic — and only pays for itself once something
 * reads it back. A mark placed after the turn's own user message is read by the turn's later
 * calls, but a turn that answers in one call makes none, and the next turn cannot read it either
 * because its history has grown past that point. Marking the end of the *replayed history*
 * instead is read by every later call of this turn AND by every turn after it, so the write is
 * never wasted. The image case makes the difference concrete: a picture marked as cacheable and
 * then read back by nobody is the most expensive thing this file could do.
 */
export function withCacheBreakpoints(
  model: string,
  messages: OrChatMessage[],
  prefixLength: number
): OrChatMessage[] {
  // A caller naming no stable prefix means there is nothing worth a cache write, and must not be
  // overridden into marking the first message anyway
  if (!needsCacheBreakpoints(model) || messages.length === 0 || prefixLength <= 0) return messages;

  const at = new Set<number>([0]);
  const endOfPrefix = Math.min(prefixLength, messages.length) - 1;
  if (endOfPrefix > 0) at.add(endOfPrefix);

  return messages.map((message, i) => (at.has(i) ? marked(message) : message));
}

/**
 * The sticky-routing key. OpenRouter keeps a conversation on the provider endpoint that holds its
 * cache, and without an explicit key it derives one by hashing the opening messages — which only
 * starts working once a cache hit has already been seen. Naming the session pins the routing from
 * the first call instead, which is the difference between a 15-call turn warming one endpoint and
 * scattering across several.
 *
 * The conversation is that pair because `pmThreadFilter` is: a reader replays their own chat
 * turns plus every autonomous turn on the board. Two readers of one project therefore share the
 * autonomous turns and diverge on their own, which is exactly a shared beginning and separate
 * ends — so one key each, not one key per board. Hashed because the ids themselves tell
 * OpenRouter nothing it needs.
 */
export function pmSessionId(projectId: string, readerId: string): string {
  return createHash("sha256").update(`pm:${projectId}:${readerId}`).digest("hex").slice(0, 32);
}
