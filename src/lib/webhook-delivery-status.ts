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

/**
 * Single-shot delivery (BP-407) — this describes the outcome of the one attempt, never a retry
 * count. Absent lastAttemptAt means never attempted, which reads as its own state rather than
 * "ok": a task that has never run and one that just succeeded are not the same claim.
 */
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
