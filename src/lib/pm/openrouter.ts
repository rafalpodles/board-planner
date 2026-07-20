const BASE_URL = () => process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

export const DEFAULT_PM_MODEL = () => process.env.PM_MODEL || "moonshotai/kimi-k2.6";

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

export type OrCompletionResult =
  | { type: "text"; content: string }
  | { type: "tool_calls"; content: string; calls: OrToolCall[]; assistantMessage: OrChatMessage }
  | { type: "error"; error: string };

export async function chatCompletion(opts: {
  model: string;
  messages: OrChatMessage[];
  tools: OrToolDefinition[];
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
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://claudeplanner.local",
        "X-Title": "ClaudePlanner PM Agent",
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        tools: opts.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        tool_choice: "auto",
      }),
    });
  } catch (err) {
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
    return { type: "tool_calls", content: message.content || "", calls, assistantMessage: message };
  }

  return { type: "text", content: message.content || "" };
}
