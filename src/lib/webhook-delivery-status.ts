import { timeAgo } from "./time";

export interface WebhookDeliveryStatus {
  tone: "none" | "ok" | "failed";
  text: string;
}

interface WebhookAttempt {
  lastAttemptAt: string | null;
  lastStatus: "ok" | "failed" | null;
  lastError: string;
}

export function webhookDeliveryStatus(webhook: WebhookAttempt): WebhookDeliveryStatus {
  if (!webhook.lastAttemptAt) return { tone: "none", text: "Not delivered yet" };

  if (webhook.lastStatus === "failed") {
    return {
      tone: "failed",
      text: `Last delivery failed ${timeAgo(webhook.lastAttemptAt)}${
        webhook.lastError ? ` — ${webhook.lastError}` : ""
      }`,
    };
  }

  return { tone: "ok", text: `Last delivered ${timeAgo(webhook.lastAttemptAt)}` };
}
