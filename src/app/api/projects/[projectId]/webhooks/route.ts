import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { Project } from "@/models/project";
import { logProjectAudit } from "@/lib/projectAudit";

export const GET = withAdmin(async (_request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const project = await Project.findById(projectId, "webhooks");
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json(project.webhooks || []);
});

export const POST = withAdmin(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const { url, events } = await request.json();
  if (!url || typeof url !== "string" || !url.trim()) {
    return NextResponse.json({ error: "URL is required" }, { status: 400 });
  }

  try {
    new URL(url.trim());
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const webhooks = project.webhooks || [];
  webhooks.push({
    url: url.trim(),
    events: events || ["task_created", "status_changed", "comment_added"],
    enabled: true,
  } as typeof webhooks[number]);
  project.webhooks = webhooks;
  await project.save();

  logProjectAudit(projectId, user._id, "settings_updated", `Webhook added: ${url.trim()}`);

  return NextResponse.json(project.webhooks, { status: 201 });
});

export const PUT = withAdmin(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const { webhookId, ...updates } = await request.json();
  if (!webhookId) {
    return NextResponse.json({ error: "webhookId is required" }, { status: 400 });
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const webhook = (project.webhooks || []).find(
    (w) => w._id.toString() === webhookId
  );
  if (!webhook) {
    return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
  }

  if (updates.url !== undefined) webhook.url = updates.url;
  if (updates.events !== undefined) webhook.events = updates.events;
  if (updates.enabled !== undefined) webhook.enabled = updates.enabled;

  await project.save();
  return NextResponse.json(project.webhooks);
});

export const DELETE = withAdmin(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const { webhookId } = await request.json();
  if (!webhookId) {
    return NextResponse.json({ error: "webhookId is required" }, { status: 400 });
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const removed = (project.webhooks || []).find((w) => w._id.toString() === webhookId);
  project.webhooks = (project.webhooks || []).filter(
    (w) => w._id.toString() !== webhookId
  );
  await project.save();

  if (removed) logProjectAudit(projectId, user._id, "settings_updated", `Webhook removed: ${removed.url}`);

  return NextResponse.json(project.webhooks);
});
