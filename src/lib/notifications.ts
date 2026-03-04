import { Project } from "@/models/project";
import { WebhookEvent, NotificationChannelType, STATUS_LABELS } from "@/types";

interface NotificationPayload {
  project: { key: string; name: string };
  task?: { taskKey: string; title: string; status: string };
  data?: Record<string, unknown>;
}

function formatSlackPayload(
  event: WebhookEvent,
  payload: NotificationPayload,
  appUrl: string
): Record<string, unknown> {
  const { project, task, data } = payload;
  const taskUrl = task ? `${appUrl}/projects/${project.key}/tasks/${task.taskKey}` : "";
  const statusLabel = task ? STATUS_LABELS[task.status as keyof typeof STATUS_LABELS] || task.status : "";

  switch (event) {
    case "task_created":
      return {
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*New task created in ${project.name}*\n<${taskUrl}|${task?.taskKey}> ${task?.title}`,
            },
          },
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: `*Status:* ${statusLabel} | *Project:* ${project.key}` },
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
              text: `*Task status changed in ${project.name}*\n<${taskUrl}|${task?.taskKey}> ${task?.title}`,
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `*${data?.oldStatus ? STATUS_LABELS[data.oldStatus as keyof typeof STATUS_LABELS] || data.oldStatus : ""}* → *${statusLabel}*`,
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
              text: `*New comment in ${project.name}*\n<${taskUrl}|${task?.taskKey}> ${task?.title}`,
            },
          },
          ...(data?.commentBody
            ? [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: String(data.commentBody).length > 200
                      ? String(data.commentBody).substring(0, 200) + "..."
                      : String(data.commentBody),
                  },
                },
              ]
            : []),
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `*By:* ${data?.author || "unknown"} | *Project:* ${project.key}`,
              },
            ],
          },
        ],
      };

    default:
      return { text: `[${project.key}] ${event}: ${task?.taskKey || ""} ${task?.title || ""}` };
  }
}

function formatDiscordPayload(
  event: WebhookEvent,
  payload: NotificationPayload,
  appUrl: string
): Record<string, unknown> {
  const { project, task, data } = payload;
  const taskUrl = task ? `${appUrl}/projects/${project.key}/tasks/${task.taskKey}` : "";
  const statusLabel = task ? STATUS_LABELS[task.status as keyof typeof STATUS_LABELS] || task.status : "";

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
            title: `New task: ${task?.taskKey}`,
            description: task?.title || "",
            url: taskUrl,
            color: colors.task_created,
            fields: [
              { name: "Status", value: statusLabel, inline: true },
              { name: "Project", value: project.name, inline: true },
            ],
          },
        ],
      };

    case "status_changed":
      return {
        embeds: [
          {
            title: `Status changed: ${task?.taskKey}`,
            description: task?.title || "",
            url: taskUrl,
            color: colors.status_changed,
            fields: [
              {
                name: "Change",
                value: `${data?.oldStatus ? STATUS_LABELS[data.oldStatus as keyof typeof STATUS_LABELS] || data.oldStatus : ""} → ${statusLabel}`,
                inline: true,
              },
              { name: "Project", value: project.name, inline: true },
            ],
          },
        ],
      };

    case "comment_added": {
      const body = data?.commentBody
        ? String(data.commentBody).length > 200
          ? String(data.commentBody).substring(0, 200) + "..."
          : String(data.commentBody)
        : "";
      return {
        embeds: [
          {
            title: `New comment on ${task?.taskKey}`,
            description: body,
            url: taskUrl,
            color: colors.comment_added,
            fields: [
              { name: "Author", value: String(data?.author || "unknown"), inline: true },
              { name: "Project", value: project.name, inline: true },
            ],
          },
        ],
      };
    }

    default:
      return { content: `[${project.key}] ${event}: ${task?.taskKey || ""} ${task?.title || ""}` };
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

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : "http://localhost:3000";

    for (const channel of active) {
      const body = JSON.stringify(formatPayload(channel.type, event, payload, appUrl));

      fetch(channel.webhookUrl, {
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
