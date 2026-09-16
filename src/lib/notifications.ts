import { Project } from "@/models/project";
import { WebhookEvent, NotificationChannelType, STATUS_LABELS } from "@/types";
import { isAllowedWebhookUrl } from "./url-validation";
import { safeFetch } from "./safe-fetch";
import { decryptSecret } from "./encryption";
import { DISCORD_NO_MENTIONS, escapeDiscord, escapeSlack, excerpt } from "./chat-markup";

interface NotificationPayload {
  project: { key: string; name: string };
  task?: { taskKey: string; title: string; status: string };
  data?: Record<string, unknown>;
}

// Encoded, because a key is not constrained to a format: a `|` in it would end Slack's link target
function taskUrlFor(appUrl: string, projectKey: string, taskKey?: string): string {
  if (!taskKey) return "";
  return `${appUrl}/projects/${encodeURIComponent(projectKey)}/tasks/${encodeURIComponent(taskKey)}`;
}

function labelOf(status: unknown): string {
  if (!status) return "";
  return STATUS_LABELS[status as keyof typeof STATUS_LABELS] || String(status);
}

function formatSlackPayload(
  event: WebhookEvent,
  payload: NotificationPayload,
  appUrl: string
): Record<string, unknown> {
  const { project, task, data } = payload;
  const e = escapeSlack;
  const taskUrl = e(taskUrlFor(appUrl, project.key, task?.taskKey));
  const statusLabel = e(labelOf(task?.status));
  const oldStatus = e(labelOf(data?.oldStatus));
  const name = e(project.name);
  const key = e(project.key);
  const taskKey = e(task?.taskKey ?? "");
  const title = e(task?.title ?? "");

  switch (event) {
    case "task_created":
      return {
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*New task created in ${name}*\n<${taskUrl}|${taskKey}> ${title}`,
            },
          },
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: `*Status:* ${statusLabel} | *Project:* ${key}` },
            ],
          },
        ],
      };

    case "status_changed":
      return {
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Task status changed in ${name}*\n<${taskUrl}|${taskKey}> ${title}`,
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `*${oldStatus}* → *${statusLabel}*`,
              },
            ],
          },
        ],
      };

    case "comment_added":
      return {
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*New comment in ${name}*\n<${taskUrl}|${taskKey}> ${title}`,
            },
          },
          ...(data?.commentBody
            ? [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: e(excerpt(String(data.commentBody), 200)),
                  },
                },
              ]
            : []),
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `*By:* ${e(String(data?.author || "unknown"))} | *Project:* ${key}`,
              },
            ],
          },
        ],
      };

    default:
      return { text: `[${key}] ${event}: ${taskKey} ${title}` };
  }
}

function formatDiscordPayload(
  event: WebhookEvent,
  payload: NotificationPayload,
  appUrl: string
): Record<string, unknown> {
  const { project, task, data } = payload;
  const d = escapeDiscord;
  const taskUrl = taskUrlFor(appUrl, project.key, task?.taskKey);
  const statusLabel = d(labelOf(task?.status));
  const oldStatus = d(labelOf(data?.oldStatus));
  const name = d(project.name);
  const taskKey = d(task?.taskKey ?? "");
  const title = d(task?.title ?? "");

  const colors: Record<WebhookEvent, number> = {
    task_created: 0x22c55e, // green
    status_changed: 0x3b82f6, // blue
    comment_added: 0xf59e0b, // amber
  };

  switch (event) {
    case "task_created":
      return {
        embeds: [
          {
            title: `New task: ${taskKey}`,
            description: title,
            url: taskUrl,
            color: colors.task_created,
            fields: [
              { name: "Status", value: statusLabel, inline: true },
              { name: "Project", value: name, inline: true },
            ],
          },
        ],
        allowed_mentions: DISCORD_NO_MENTIONS,
      };

    case "status_changed":
      return {
        embeds: [
          {
            title: `Status changed: ${taskKey}`,
            description: title,
            url: taskUrl,
            color: colors.status_changed,
            fields: [
              {
                name: "Change",
                value: `${oldStatus} → ${statusLabel}`,
                inline: true,
              },
              { name: "Project", value: name, inline: true },
            ],
          },
        ],
        allowed_mentions: DISCORD_NO_MENTIONS,
      };

    case "comment_added": {
      const body = data?.commentBody ? d(excerpt(String(data.commentBody), 200)) : "";
      return {
        embeds: [
          {
            title: `New comment on ${taskKey}`,
            description: body,
            url: taskUrl,
            color: colors.comment_added,
            fields: [
              { name: "Author", value: d(String(data?.author || "unknown")), inline: true },
              { name: "Project", value: name, inline: true },
            ],
          },
        ],
        allowed_mentions: DISCORD_NO_MENTIONS,
      };
    }

    default:
      return { content: `[${d(project.key)}] ${event}: ${taskKey} ${title}`, allowed_mentions: DISCORD_NO_MENTIONS };
  }
}

function formatPayload(
  channelType: NotificationChannelType,
  event: WebhookEvent,
  payload: NotificationPayload,
  appUrl: string
): Record<string, unknown> {
  switch (channelType) {
    case "slack":
      return formatSlackPayload(event, payload, appUrl);
    case "discord":
      return formatDiscordPayload(event, payload, appUrl);
    default:
      return {};
  }
}

export async function dispatchNotifications(
  projectId: string,
  event: WebhookEvent,
  payload: NotificationPayload
): Promise<void> {
  try {
    const project = await Project.findById(projectId, "notificationChannels").lean();
    if (!project?.notificationChannels?.length) return;

    const active = project.notificationChannels.filter(
      (ch) => ch.enabled && ch.events.includes(event)
    );
    if (active.length === 0) return;

    const appUrl = process.env.NEXT_PUBLIC_APP_URL
      || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "http://localhost:3000");

    for (const channel of active) {
      let webhookUrl: string;
      try {
        webhookUrl = decryptSecret(channel.webhookUrl);
      } catch {
        // A rotation that lost the old key leaves an unreadable value; posting the ciphertext at
        // some URL is the only worse answer than saying nothing. Named, because a channel that
        // silently stops delivering is otherwise indistinguishable from a board with nothing to say.
        console.error(
          `Project chat webhook could not be decrypted: project ${projectId}, channel "${channel.name}"`
        );
        continue;
      }
      if (!isAllowedWebhookUrl(webhookUrl)) continue;
      const body = JSON.stringify(formatPayload(channel.type, event, payload, appUrl));

      safeFetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {
        // Notification delivery failures are silently ignored
      });
    }
  } catch {
    console.warn("Failed to dispatch notifications");
  }
}
