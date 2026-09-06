import { Project } from "@/models/project";
import { WebhookEvent } from "@/types";
import { isAllowedWebhookUrl } from "./url-validation";
import { safeFetch, BlockedDestinationError } from "./safe-fetch";
import { signatureHeaders } from "./webhook-signature";

interface WebhookPayload {
  event: WebhookEvent;
  project: { key: string; name: string };
  task?: { taskKey: string; title: string; status: string };
  data?: Record<string, unknown>;
  timestamp: string;
}

async function recordDelivery(
  projectId: string,
  webhookId: string,
  attemptStartedAt: Date,
  status: "ok" | "failed",
  error: string
): Promise<void> {
  try {
    await Project.updateOne(
      {
        _id: projectId,
        webhooks: {
          $elemMatch: {
            _id: webhookId,
            $or: [{ lastAttemptAt: null }, { lastAttemptAt: { $lte: attemptStartedAt } }],
          },
        },
      },
      {
        $set: {
          "webhooks.$.lastAttemptAt": attemptStartedAt,
          "webhooks.$.lastStatus": status,
          "webhooks.$.lastError": error,
        },
      }
    );
  } catch {
    console.warn("Failed to record webhook delivery outcome");
  }
}

function messageFor(err: unknown): string {
  if (err instanceof BlockedDestinationError) return "Blocked destination";
  return err instanceof Error ? err.message : String(err);
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

    for (const webhook of activeWebhooks) {
      const webhookId = String(webhook._id);
      const attemptStartedAt = new Date();

      if (!isAllowedWebhookUrl(webhook.url)) {
        recordDelivery(projectId, webhookId, attemptStartedAt, "failed", "Blocked destination");
        continue;
      }

      safeFetch(webhook.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...signatureHeaders(body) },
        body,
        signal: AbortSignal.timeout(10_000),
      }).then(
        (response) =>
          recordDelivery(
            projectId,
            webhookId,
            attemptStartedAt,
            response.ok ? "ok" : "failed",
            response.ok ? "" : `HTTP ${response.status}`
          ),
        (err) => recordDelivery(projectId, webhookId, attemptStartedAt, "failed", messageFor(err))
      );
    }
  } catch {
    console.warn("Failed to dispatch webhooks");
  }
}
