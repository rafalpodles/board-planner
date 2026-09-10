import { createHash } from "crypto";
import type { OrChatMessage } from "./openrouter";

/**
 * Prompt caching across the round-trips of one turn (BP-568).
 *
 * A turn is up to MAX_STEPS calls and the front of every request is byte-identical across all of
 * them — the tool definitions, the system prompt and the replayed history. Whether that prefix is
 * billed once or fifteen times is the provider's decision, and providers split two ways: OpenAI,
 * DeepSeek, Grok, Moonshot, Groq, Z.AI and Gemini 2.5 cache automatically, while Anthropic,
 * Alibaba Qwen and Gemini cache only what a `cache_control` breakpoint marks.
 *
 * So the breakpoints are sent to the second group only. They are not free to send to the first:
 * marking a block means rewriting a string `content` into an array of parts, and a request shape
 * changed for a provider that ignores the marking is a change with no upside.
 */

/**
 * Matched against the model id as OpenRouter spells it. Deliberately narrow — a model absent from
 * this list is assumed to cache automatically, which is the safe way round: a missed breakpoint
 * costs money, a breakpoint sent to a provider that cannot read it costs a rewritten request.
 */
const EXPLICIT_BREAKPOINT_MODELS = [/^anthropic\//i, /^qwen\//i, /^google\/gemini/i];

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
 * Two breakpoints, because a turn is not the only thing that repeats. The first marks the system
 * prompt, which survives into the next turn as well; the second marks the end of `prefixLength`,
 * the messages that were already there when the turn started, which is the largest run of bytes
 * every call of this turn shares. Anthropic permits four.
 *
 * `prefixLength` counts messages, not bytes: everything the agent appends as the turn runs — the
 * assistant's tool calls and their results — sits after it and is never marked.
 */
export function withCacheBreakpoints(
  model: string,
  messages: OrChatMessage[],
  prefixLength: number
): OrChatMessage[] {
  if (!needsCacheBreakpoints(model) || messages.length === 0) return messages;

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
 * A thread is per project and per reader (`pmThreadFilter`), so that pair is the conversation.
 * Hashed because the id itself tells OpenRouter nothing it needs.
 */
export function pmSessionId(projectId: string, readerId: string): string {
  return createHash("sha256").update(`pm:${projectId}:${readerId}`).digest("hex").slice(0, 32);
}
