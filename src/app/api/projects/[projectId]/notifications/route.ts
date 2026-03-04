import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { Project } from "@/models/project";
import { logProjectAudit } from "@/lib/projectAudit";
import { NOTIFICATION_CHANNEL_TYPES, WEBHOOK_EVENTS, NotificationChannelType } from "@/types";

export const GET = withAdmin(async (_request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const project = await Project.findById(projectId, "notificationChannels");
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json(project.notificationChannels || []);
});

export const POST = withAdmin(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const { type, name, webhookUrl, events } = await request.json();

  if (!type || !NOTIFICATION_CHANNEL_TYPES.includes(type as NotificationChannelType)) {
    return NextResponse.json(
      { error: `Type must be one of: ${NOTIFICATION_CHANNEL_TYPES.join(", ")}` },
      { status: 400 }
    );
  }

  if (!webhookUrl || typeof webhookUrl !== "string" || !webhookUrl.trim()) {
    return NextResponse.json({ error: "Webhook URL is required" }, { status: 400 });
  }

  try {
    new URL(webhookUrl.trim());
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const channels = project.notificationChannels || [];
  channels.push({
    type: type as NotificationChannelType,
    name: name.trim(),
    webhookUrl: webhookUrl.trim(),
    events: events || [...WEBHOOK_EVENTS],
    enabled: true,
  } as typeof channels[number]);
  project.notificationChannels = channels;
  await project.save();

  logProjectAudit(projectId, user._id, "settings_updated", `Notification channel added: ${name.trim()} (${type})`);

  return NextResponse.json(project.notificationChannels, { status: 201 });
});

export const PUT = withAdmin(async (request, { params }) => {
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

  if (updates.name !== undefined) channel.name = updates.name;
  if (updates.webhookUrl !== undefined) channel.webhookUrl = updates.webhookUrl;
  if (updates.events !== undefined) channel.events = updates.events;
  if (updates.enabled !== undefined) channel.enabled = updates.enabled;

  await project.save();
  return NextResponse.json(project.notificationChannels);
});

export const DELETE = withAdmin(async (request, { params, user }) => {
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

  return NextResponse.json(project.notificationChannels);
});
