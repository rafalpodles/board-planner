import { WEBHOOK_EVENTS, WebhookEvent } from "@/types";

export function parseWebhookUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  try {
    new URL(trimmed);
  } catch {
    return null;
  }
  return trimmed;
}

export function parseWebhookEvents(value: unknown): WebhookEvent[] | null {
  if (!Array.isArray(value)) return null;
  const known = value.filter((e): e is WebhookEvent => WEBHOOK_EVENTS.includes(e as WebhookEvent));
  return known.length === value.length ? known : null;
}
