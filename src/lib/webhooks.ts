import { Project } from "@/models/project";
import { WebhookEvent } from "@/types";
import { isAllowedWebhookUrl } from "./url-validation";

interface WebhookPayload {
  event: WebhookEvent;
  project: { key: string; name: string };
  task?: { taskKey: string; title: string; status: string };
  data?: Record<string, unknown>;
  timestamp: string;
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
      fetch(webhook.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {
        // Webhook delivery failures are silently ignored
      });
    }
  } catch {
    // Webhook dispatch should never break the main operation
    console.warn("Failed to dispatch webhooks");
  }
}
