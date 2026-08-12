import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { Project } from "@/models/project";
import { logProjectAudit } from "@/lib/projectAudit";
import { NOTIFICATION_CHANNEL_TYPES, WEBHOOK_EVENTS, NotificationChannelType } from "@/types";
import { sanitizeProjectSecrets } from "@/lib/project-secrets";
import { parseWebhookUrl, parseWebhookEvents } from "@/lib/webhook-input";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function masked(project: any) {
  return sanitizeProjectSecrets(project.toObject()).notificationChannels || [];
}

export const GET = withProjectOwner(async (_request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const project = await Project.findById(projectId, "notificationChannels");
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json(masked(project));
});

export const POST = withProjectOwner(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const { type, name, webhookUrl, events } = await request.json();

  if (!type || !NOTIFICATION_CHANNEL_TYPES.includes(type as NotificationChannelType)) {
    return NextResponse.json(
      { error: `Type must be one of: ${NOTIFICATION_CHANNEL_TYPES.join(", ")}` },
      { status: 400 }
    );
  }

  const parsedUrl = parseWebhookUrl(webhookUrl);
  if (!parsedUrl) {
    return NextResponse.json({ error: "A valid webhook URL is required" }, { status: 400 });
  }

  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const parsedEvents = events === undefined ? [...WEBHOOK_EVENTS] : parseWebhookEvents(events);
  if (!parsedEvents) {
    return NextResponse.json(
      { error: `events must be a list of: ${WEBHOOK_EVENTS.join(", ")}` },
      { status: 400 }
    );
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const channels = project.notificationChannels || [];
  channels.push({
    type: type as NotificationChannelType,
    name: name.trim(),
    webhookUrl: parsedUrl,
    events: parsedEvents,
    enabled: true,
  } as typeof channels[number]);
  project.notificationChannels = channels;
  await project.save();

  logProjectAudit(projectId, user._id, "settings_updated", `Notification channel added: ${name.trim()} (${type})`);

  return NextResponse.json(masked(project), { status: 201 });
});

export const PUT = withProjectOwner(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const { channelId, ...updates } = await request.json();
  if (!channelId) {
    return NextResponse.json({ error: "channelId is required" }, { status: 400 });
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const channel = (project.notificationChannels || []).find(
    (ch) => ch._id.toString() === channelId
  );
  if (!channel) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }

  if (updates.name !== undefined) {
    if (typeof updates.name !== "string" || !updates.name.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    channel.name = updates.name.trim();
  }
  if (updates.webhookUrl !== undefined) {
    const parsedUrl = parseWebhookUrl(updates.webhookUrl);
    if (!parsedUrl) {
      return NextResponse.json({ error: "A valid webhook URL is required" }, { status: 400 });
    }
    channel.webhookUrl = parsedUrl;
  }
  if (updates.events !== undefined) {
    const parsedEvents = parseWebhookEvents(updates.events);
    if (!parsedEvents) {
      return NextResponse.json(
        { error: `events must be a list of: ${WEBHOOK_EVENTS.join(", ")}` },
        { status: 400 }
      );
    }
    channel.events = parsedEvents;
  }
  if (updates.enabled !== undefined) channel.enabled = !!updates.enabled;

  await project.save();
  return NextResponse.json(masked(project));
});

export const DELETE = withProjectOwner(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const { channelId } = await request.json();
  if (!channelId) {
    return NextResponse.json({ error: "channelId is required" }, { status: 400 });
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const removed = (project.notificationChannels || []).find((ch) => ch._id.toString() === channelId);
  project.notificationChannels = (project.notificationChannels || []).filter(
    (ch) => ch._id.toString() !== channelId
  );
  await project.save();

  if (removed) {
    logProjectAudit(projectId, user._id, "settings_updated", `Notification channel removed: ${removed.name}`);
  }

  return NextResponse.json(masked(project));
});
