import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { Project } from "@/models/project";
import { logProjectAudit } from "@/lib/projectAudit";
import { maskSecretUrl, sanitizeProjectSecrets } from "@/lib/project-secrets";
import { parseWebhookUrl, parseWebhookEvents } from "@/lib/webhook-input";
import { WEBHOOK_EVENTS } from "@/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function masked(project: any) {
  return sanitizeProjectSecrets(project.toObject()).webhooks || [];
}

export const GET = withProjectOwner(async (_request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const project = await Project.findById(projectId, "webhooks");
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json(masked(project));
});

export const POST = withProjectOwner(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const { url, events } = await request.json();
  const parsedUrl = parseWebhookUrl(url);
  if (!parsedUrl) {
    return NextResponse.json({ error: "A valid URL is required" }, { status: 400 });
  }

  const parsedEvents = events === undefined ? [...WEBHOOK_EVENTS] : parseWebhookEvents(events);
  if (!parsedEvents) {
    return NextResponse.json(
      { error: `events must be a list of: ${WEBHOOK_EVENTS.join(", ")}` },
      { status: 400 }
    );
  }

  const project = await Project.findOneAndUpdate(
    { _id: projectId },
    { $push: { webhooks: { url: parsedUrl, events: parsedEvents, enabled: true } } },
    { returnDocument: "after" }
  );
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  logProjectAudit(projectId, user._id, "settings_updated", `Webhook added: ${maskSecretUrl(parsedUrl)}`);

  return NextResponse.json(masked(project), { status: 201 });
});

export const PUT = withProjectOwner(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const { webhookId, ...updates } = await request.json();
  if (!webhookId) {
    return NextResponse.json({ error: "webhookId is required" }, { status: 400 });
  }

  const setFields: Record<string, unknown> = {};
  if (updates.url !== undefined) {
    const parsedUrl = parseWebhookUrl(updates.url);
    if (!parsedUrl) {
      return NextResponse.json({ error: "A valid URL is required" }, { status: 400 });
    }
    setFields["webhooks.$.url"] = parsedUrl;
  }
  if (updates.events !== undefined) {
    const parsedEvents = parseWebhookEvents(updates.events);
    if (!parsedEvents) {
      return NextResponse.json(
        { error: `events must be a list of: ${WEBHOOK_EVENTS.join(", ")}` },
        { status: 400 }
      );
    }
    setFields["webhooks.$.events"] = parsedEvents;
  }
  if (updates.enabled !== undefined) setFields["webhooks.$.enabled"] = !!updates.enabled;

  const project = await Project.findOneAndUpdate(
    { _id: projectId, "webhooks._id": webhookId },
    { $set: setFields },
    { returnDocument: "after" }
  );
  if (!project) {
    return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
  }

  return NextResponse.json(masked(project));
});

export const DELETE = withProjectOwner(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const { webhookId } = await request.json();
  if (!webhookId) {
    return NextResponse.json({ error: "webhookId is required" }, { status: 400 });
  }

  const before = await Project.findOne(
    { _id: projectId, "webhooks._id": webhookId },
    { "webhooks.$": 1 }
  ).lean();
  const removed = before?.webhooks?.[0];

  const project = await Project.findOneAndUpdate(
    { _id: projectId },
    { $pull: { webhooks: { _id: webhookId } } },
    { returnDocument: "after" }
  );
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (removed) logProjectAudit(projectId, user._id, "settings_updated", `Webhook removed: ${maskSecretUrl(removed.url)}`);

  return NextResponse.json(masked(project));
});
