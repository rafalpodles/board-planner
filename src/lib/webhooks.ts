import { Project } from "@/models/project";
import { WebhookEvent } from "@/types";
import { isAllowedWebhookUrl } from "./url-validation";
import { safeFetch } from "./safe-fetch";
import { signatureHeaders } from "./webhook-signature";

interface WebhookPayload {
  event: WebhookEvent;
  project: { key: string; name: string };
  task?: { taskKey: string; title: string; status: string };
  data?: Record<string, unknown>;
  timestamp: string;
}

/**
 * Delivery is single-shot, deliberately (BP-407) — the same fire-and-forget choice the activity
 * log and dispatchNotifications already make, so a request never blocks or fails on a side effect.
 * What was missing was the other half of that trade: the ONE attempt's outcome has to land
 * somewhere an operator can find it, or a receiver that is down for a second loses the event with
 * no trace anywhere. Recorded onto the webhook's own row, the same idiom `apiToken.lastUsedAt` and
 * `worker.lastSeenAt` already use for "when did this last do something".
 *
 * Never awaited by dispatchWebhooks or its callers — recording the outcome happens on its own
 * time, after the response the caller was never going to wait for either.
 */
async function recordDelivery(
  projectId: string,
  webhookId: string,
  status: "ok" | "failed",
  error: string
): Promise<void> {
  try {
    await Project.updateOne(
      { _id: projectId, "webhooks._id": webhookId },
      {
        $set: {
          "webhooks.$.lastAttemptAt": new Date(),
          "webhooks.$.lastStatus": status,
          "webhooks.$.lastError": error,
        },
      }
    );
  } catch {
    // Recording the outcome must never itself become a new silent failure with no trace — but it
    // also must not throw into the fire-and-forget chain dispatchWebhooks starts, which nothing
    // downstream is waiting to catch.
    console.warn("Failed to record webhook delivery outcome");
  }
}

export async function dispatchWebhooks(
  projectId: string,
  event: WebhookEvent,
  payload: Omit<WebhookPayload, "event" | "timestamp">
): Promise<void> {
  try {
    const project = await Project.findById(projectId, "webhooks").lean();
    if (!project?.webhooks?.length) return;

    const activeWebhooks = project.webhooks.filter(
      (w) => w.enabled && w.events.includes(event)
    );
    if (activeWebhooks.length === 0) return;

    const body = JSON.stringify({
      event,
      ...payload,
      timestamp: new Date().toISOString(),
    });

    // Fire-and-forget, don't block the main request
    for (const webhook of activeWebhooks) {
      if (!isAllowedWebhookUrl(webhook.url)) continue;
      const webhookId = String(webhook._id);
      safeFetch(webhook.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...signatureHeaders(body) },
        body,
        signal: AbortSignal.timeout(10_000),
      }).then(
        // A rejected safeFetch is a network/timeout/blocked-destination failure; a RESOLVED one
        // whose status isn't 2xx is the receiver saying no — the original `.catch(() => {})` only
        // ever saw the first kind, so a webhook receiver answering 500 read as delivered.
        (response) =>
          recordDelivery(projectId, webhookId, response.ok ? "ok" : "failed", response.ok ? "" : `HTTP ${response.status}`),
        (err) => recordDelivery(projectId, webhookId, "failed", err instanceof Error ? err.message : String(err))
      );
    }
  } catch {
    // Webhook dispatch should never break the main operation
    console.warn("Failed to dispatch webhooks");
  }
}
