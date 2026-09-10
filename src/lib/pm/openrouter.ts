import { APP_NAME, APP_DOMAIN } from "@/lib/brand";
import { withCacheBreakpoints } from "./prompt-cache";

const BASE_URL = () => process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

export const DEFAULT_PM_MODEL = () => process.env.PM_MODEL || "moonshotai/kimi-k2.6";

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
  | { type: "error"; error: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function usageOf(data: any): OrUsage | undefined {
  const usage = data?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const prompt = Number(usage.prompt_tokens);
  const completion = Number(usage.completion_tokens);
  const total = Number(usage.total_tokens);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion) && !Number.isFinite(total)) {
    return undefined;
  }
  const promptTokens = Number.isFinite(prompt) ? prompt : 0;
  const completionTokens = Number.isFinite(completion) ? completion : 0;
  return {
    promptTokens,
    completionTokens,
    // Some providers omit the total; adding the two is what it means
    totalTokens: Number.isFinite(total) ? total : promptTokens + completionTokens,
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
  signal?: AbortSignal;
}): Promise<OrCompletionResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { type: "error", error: "OPENROUTER_API_KEY is not configured" };
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || `https://${APP_DOMAIN}`,
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
        max_tokens: MAX_TOKENS(),
        tools: opts.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        tool_choice: "auto",
      }),
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) return { type: "aborted" };
    return { type: "error", error: `OpenRouter request failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return { type: "error", error: `OpenRouter HTTP ${response.status}: ${bodyText.slice(0, 300)}` };
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
    return { type: "error", error: apiError ? `OpenRouter error: ${apiError}` : "OpenRouter returned no choices" };
  }

  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (rawCalls.length > 0) {
    const calls: OrToolCall[] = rawCalls.map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tc: any, i: number) => {
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
      }
    );
    return {
      type: "tool_calls",
      content: message.content || "",
      calls,
      assistantMessage: message,
      usage: usageOf(data),
    };
  }

  return { type: "text", content: message.content || "", usage: usageOf(data) };
}
