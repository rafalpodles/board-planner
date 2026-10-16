import { APP_NAME, APP_DOMAIN } from "@/lib/brand";
import { managedProviderOf } from "@/lib/managed-models";
import { selfOrigin } from "@/lib/session";
import { withCacheBreakpoints } from "./prompt-cache";

export const OPENROUTER_BASE_URL = () => process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

export type ProviderPreferences = { data_collection: "deny"; only?: string[] };

// On the platform's key only, where the sub-processor list speaks: no upstream that may train on prompts, and
// a provider's own models only from that provider. The open-weight gpt-oss models are not served by OpenAI at all.
export function platformProviderPreferences(model: string): ProviderPreferences {
  const provider = managedProviderOf(model);
  return provider ? { data_collection: "deny", only: provider.servedBy } : { data_collection: "deny" };
}

const MAX_TOKENS = () => Number(process.env.PM_MAX_TOKENS) || 8192;

export interface OrToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface OrToolCall {
  id: string;
  name: string;
  args: Record<string, unknown> | null;
  parseError?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OrChatMessage = Record<string, any>;

/**
 * What one round-trip cost, as the provider reported it. Absent when the response carried no
 * `usage` block — every OpenRouter model returns one today, but a stub or a future provider need
 * not, and a missing number must read as "unknown" rather than as zero (BP-284).
 */
export interface OrUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Prompt tokens the provider served from its cache. A **subset** of `promptTokens`, never an
   * addition to it — the day's total does not change when caching starts working, only what that
   * total costs. Absent means the provider reported no cache activity, which is a real answer
   * (nothing was cached) rather than the unknown a missing `usage` block is (BP-568).
   */
  cachedPromptTokens: number;
  /** Prompt tokens written into the cache. Only providers that price cache writes report it. */
  cacheWriteTokens: number;
}

export type OrCompletionResult =
  | { type: "text"; content: string; usage?: OrUsage }
  | {
      type: "tool_calls";
      content: string;
      calls: OrToolCall[];
      assistantMessage: OrChatMessage;
      usage?: OrUsage;
    }
  | { type: "aborted" }
  /** `sent`: the request reached the provider and began to answer, so it was billed though nothing usable came back */
  | { type: "error"; error: string; sent?: boolean };

export type OrStreamDelta =
  | { type: "text"; text: string }
  | { type: "tool"; name: string };

/** Silence from the provider, comments and chunks alike, after which a stream is given up on */
export const STREAM_IDLE_MS = 60_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function usageOf(data: any): OrUsage | undefined {
  const usage = data?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const prompt = Number(usage.prompt_tokens);
  const completion = Number(usage.completion_tokens);
  const total = Number(usage.total_tokens);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion) && !Number.isFinite(total)) {
    return undefined;
  }
  const promptTokens = Number.isFinite(prompt) ? Math.max(0, prompt) : 0;
  const completionTokens = Number.isFinite(completion) ? Math.max(0, completion) : 0;
  return {
    promptTokens,
    completionTokens,
    // Some providers omit the total, or report 0 for it; adding the two is what it means, and a limit is made of this number
    totalTokens: Number.isFinite(total) && total > 0 ? total : promptTokens + completionTokens,
    ...cacheTokensOf(usage.prompt_tokens_details),
  };
}

/**
 * OpenRouter reports cache activity on every response with no request parameter to ask for it, in
 * `usage.prompt_tokens_details`. A provider that caches nothing omits the block entirely, and a
 * provider that caches but does not price writes omits `cache_write_tokens` alone — both read as
 * zero, because "no tokens were served from cache" is what they mean (BP-568).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cacheTokensOf(details: any): { cachedPromptTokens: number; cacheWriteTokens: number } {
  const positive = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return {
    cachedPromptTokens: positive(details?.cached_tokens),
    cacheWriteTokens: positive(details?.cache_write_tokens),
  };
}

export async function chatCompletion(opts: {
  model: string;
  apiKey: string;
  messages: OrChatMessage[];
  tools: OrToolDefinition[];
  /**
   * How many leading messages are byte-identical on every call of this turn — the stable prefix a
   * cache breakpoint is worth spending on. Defaults to all of them, which is what a single-call
   * caller has (BP-568).
   */
  cachePrefixLength?: number;
  /** Sticky-routing key, so the turn's later calls reach the endpoint its first call warmed */
  sessionId?: string;
  provider?: ProviderPreferences;
  signal?: AbortSignal;
  /** Asks the provider to stream the answer and reports it as it arrives; the result is the same one a plain call returns */
  onDelta?: (delta: OrStreamDelta) => void;
  idleMs?: number;
}): Promise<OrCompletionResult> {
  const { apiKey } = opts;
  // A provider's refusal of a key can quote it back, and what lands here reaches a thread every member reads
  const withoutKey = (text: string) => (apiKey ? text.replaceAll(apiKey, "[key]") : text);

  const streaming = opts.onDelta !== undefined;
  const idle = streaming ? new AbortController() : null;
  const signal = idle && opts.signal ? AbortSignal.any([opts.signal, idle.signal]) : (idle?.signal ?? opts.signal);

  let response: Response;
  try {
    response = await fetch(`${OPENROUTER_BASE_URL()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": selfOrigin() ?? `https://${APP_DOMAIN}`,
        "X-Title": `${APP_NAME} PM Agent`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: withCacheBreakpoints(
          opts.model,
          opts.messages,
          opts.cachePrefixLength ?? opts.messages.length
        ),
        ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
        ...(opts.provider ? { provider: opts.provider } : {}),
        max_tokens: MAX_TOKENS(),
        // A call with no tools sends none: an empty list beside a tool_choice is refused by some providers
        ...(opts.tools.length > 0 && {
          tools: opts.tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
          tool_choice: "auto",
        }),
        ...(streaming && { stream: true, stream_options: { include_usage: true } }),
      }),
      signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) return { type: "aborted" };
    return { type: "error", error: `OpenRouter request failed: ${withoutKey(err instanceof Error ? err.message : String(err))}` };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return { type: "error", error: `OpenRouter HTTP ${response.status}: ${withoutKey(bodyText).slice(0, 300)}` };
  }

  if (streaming) {
    return readStream(response, opts.onDelta!, { signal: opts.signal, idle: idle!, idleMs: opts.idleMs ?? STREAM_IDLE_MS, withoutKey });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any;
  try {
    data = await response.json();
  } catch {
    if (opts.signal?.aborted) return { type: "aborted" };
    return { type: "error", error: "OpenRouter returned a non-JSON response" };
  }

  const message = data?.choices?.[0]?.message;
  if (!message) {
    const apiError = data?.error?.message;
    return { type: "error", error: apiError ? `OpenRouter error: ${withoutKey(String(apiError))}` : "OpenRouter returned no choices" };
  }

  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (rawCalls.length > 0) {
    return {
      type: "tool_calls",
      content: message.content || "",
      calls: parseToolCalls(rawCalls),
      assistantMessage: message,
      usage: usageOf(data),
    };
  }

  return { type: "text", content: message.content || "", usage: usageOf(data) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseToolCalls(rawCalls: any[]): OrToolCall[] {
  return rawCalls.map((tc, i) => {
    const id = tc?.id || `call_${i}`;
    const name = tc?.function?.name || "";
    const rawArgs = tc?.function?.arguments ?? "{}";
    try {
      const parsed = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : rawArgs;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { id, name, args: null, parseError: "arguments must be a JSON object" };
      }
      return { id, name, args: parsed as Record<string, unknown> };
    } catch {
      return { id, name, args: null, parseError: `arguments are not valid JSON: ${String(rawArgs).slice(0, 200)}` };
    }
  });
}

// A stream cut short may hold half a tool call, so only one that ends as the protocol says is believed

async function readStream(
  response: Response,
  onDelta: (delta: OrStreamDelta) => void,
  { signal, idle, idleMs, withoutKey }: { signal?: AbortSignal; idle: AbortController; idleMs: number; withoutKey: (text: string) => string }
): Promise<OrCompletionResult> {
  if (!response.body) return { type: "error", error: "OpenRouter returned no stream" };

  let content = "";
  let usage: OrUsage | undefined;
  let finished = false;
  let failure: string | null = null;
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const rearm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      idle.abort();
    }, idleMs);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const take = (chunk: any) => {
    if (chunk?.error) {
      failure = `OpenRouter error: ${withoutKey(String(chunk.error.message ?? "the stream failed"))}`;
      return;
    }
    if (chunk?.usage) usage = usageOf(chunk);
    const choice = chunk?.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      onDelta({ type: "text", text: delta.content });
    }
    for (const part of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = Number.isInteger(part?.index) ? part.index : 0;
      const call = calls.get(index) ?? { id: "", name: "", args: "" };
      const named = Boolean(call.name);
      if (part?.id) call.id = part.id;
      if (part?.function?.name) call.name += part.function.name;
      if (typeof part?.function?.arguments === "string") call.args += part.function.arguments;
      calls.set(index, call);
      if (!named && call.name) onDelta({ type: "tool", name: call.name });
    }
    if (choice.finish_reason === "error") failure = failure ?? "OpenRouter error: the provider failed mid-answer";
    if (choice.finish_reason) finished = true;
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  rearm();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rearm();
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        if (data === "[DONE]") {
          finished = true;
          continue;
        }
        try {
          take(JSON.parse(data));
        } catch {
          failure = failure ?? "OpenRouter sent an unreadable chunk";
        }
        if (failure) break;
      }
      if (failure) break;
    }
  } catch {
    if (signal?.aborted) return { type: "aborted" };
    failure = timedOut
      ? `The model stopped responding (nothing received for ${Math.round(idleMs / 1000)} s).`
      : "The connection to the model was cut off before the answer was complete.";
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }

  if (signal?.aborted) return { type: "aborted" };
  if (failure) return { type: "error", error: failure, sent: true };
  if (!finished) return { type: "error", error: "The connection to the model was cut off before the answer was complete.", sent: true };

  if (calls.size > 0) {
    const raw = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, c], i) => ({ id: c.id || `call_${i}`, type: "function", function: { name: c.name, arguments: c.args } }));
    return {
      type: "tool_calls",
      content,
      calls: parseToolCalls(raw),
      assistantMessage: { role: "assistant", content, tool_calls: raw },
      usage,
    };
  }
  return { type: "text", content, usage };
}
