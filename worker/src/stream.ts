export type RateLimitStatus = "allowed" | "allowed_warning" | "rejected";

export interface RateLimitInfo {
  status?: RateLimitStatus;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
}

export interface RateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info?: RateLimitInfo;
}

export type ResultSubtype = "success" | "error_max_turns" | "error_during_execution";

export interface ResultEvent {
  type: "result";
  subtype?: ResultSubtype;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  num_turns?: number;
  total_cost_usd?: number;
}

export interface MessageEvent {
  type: "assistant" | "user";
  message?: { role?: string; content?: unknown };
}

export interface SystemEvent {
  type: "system";
  subtype?: string;
}

export interface OtherEvent {
  type: string;
}

export type StreamEvent = SystemEvent | MessageEvent | RateLimitEvent | ResultEvent | OtherEvent;

export function isResultEvent(event: StreamEvent): event is ResultEvent {
  return event.type === "result";
}

export function isRateLimitEvent(event: StreamEvent): event is RateLimitEvent {
  return event.type === "rate_limit_event";
}

export function parseStream(stdout: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    if (typeof (parsed as { type?: unknown }).type !== "string") continue;
    events.push(parsed as StreamEvent);
  }
  return events;
}

export function lastResultEvent(events: StreamEvent[]): ResultEvent | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (isResultEvent(event)) return event;
  }
  return undefined;
}
