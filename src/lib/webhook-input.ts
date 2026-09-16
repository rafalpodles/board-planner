import { WEBHOOK_EVENTS, WebhookEvent } from "@/types";

export const MAX_WEBHOOK_URL_LENGTH = 2048;
export const MAX_WEBHOOKS = 20;
export const MAX_NOTIFICATION_CHANNELS = 20;
export const MAX_CHANNEL_NAME_LENGTH = 100;

export function parseWebhookUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed.length > MAX_WEBHOOK_URL_LENGTH) return null;
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
