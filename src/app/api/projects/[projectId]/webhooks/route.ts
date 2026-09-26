import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { Project } from "@/models/project";
import { logProjectAudit } from "@/lib/projectAudit";
import { webhookChanges } from "@/lib/settings-audit";
import { canonicalObjectId } from "@/lib/object-id";
import { maskSecretUrl, sanitizeProjectSecrets } from "@/lib/project-secrets";
import { parseWebhookUrl, parseWebhookEvents, MAX_WEBHOOK_URL_LENGTH, MAX_WEBHOOKS } from "@/lib/webhook-input";
import { WEBHOOK_EVENTS } from "@/types";
import { isAllowedWebhookUrl, WEBHOOK_DESTINATION, WEBHOOK_DESTINATION_REFUSED } from "@/lib/url-validation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function masked(project: any) {
  return sanitizeProjectSecrets(project.toObject()).webhooks || [];
}

// All three writers below use an atomic operator ($push/$set/$pull) rather than load, mutate
// in memory, save() — that pattern re-sent the WHOLE webhooks array on every save, and
// dispatchWebhooks records a delivery outcome onto one row from its own background write
// (BP-407). A save() landing after that write clobbered it with the stale in-memory snapshot.
export const POST = withProjectOwner(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const { url, events } = await request.json();
  const parsedUrl = parseWebhookUrl(url);
  if (!parsedUrl) {
    return NextResponse.json(
      { error: `A valid URL of at most ${MAX_WEBHOOK_URL_LENGTH} characters is required` },
      { status: 400 }
    );
  }
  if (!isAllowedWebhookUrl(parsedUrl, WEBHOOK_DESTINATION)) {
    return NextResponse.json({ error: WEBHOOK_DESTINATION_REFUSED }, { status: 400 });
  }

  const parsedEvents = events === undefined ? [...WEBHOOK_EVENTS] : parseWebhookEvents(events);
  if (!parsedEvents) {
    return NextResponse.json(
      { error: `events must be a list of: ${WEBHOOK_EVENTS.join(", ")}` },
      { status: 400 }
    );
  }

  // The count is part of the match, so two requests racing cannot both slip past the cap: one card
  // move fires every webhook, and a few thousand at one host is a flood sent from this instance
  const project = await Project.findOneAndUpdate(
    { _id: projectId, [`webhooks.${MAX_WEBHOOKS - 1}`]: { $exists: false } },
    { $push: { webhooks: { url: parsedUrl, events: parsedEvents, enabled: true } } },
    { returnDocument: "after" }
  );
  if (!project) {
    if (await Project.exists({ _id: projectId })) {
      return NextResponse.json({ error: `A project can have at most ${MAX_WEBHOOKS} webhooks` }, { status: 400 });
    }
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  logProjectAudit(projectId, user._id, "settings_updated", `Webhook added: ${maskSecretUrl(parsedUrl)}`);

  return NextResponse.json(masked(project), { status: 201 });
});

export const PUT = withProjectOwner(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const { webhookId: rawWebhookId, ...updates } = await request.json();
  const webhookId = canonicalObjectId(rawWebhookId);
  if (!webhookId) {
    return NextResponse.json({ error: "webhookId is required" }, { status: 400 });
  }

  const changes: { url?: string; events?: string[]; enabled?: boolean } = {};
  if (updates.url !== undefined) {
    const parsedUrl = parseWebhookUrl(updates.url);
    if (!parsedUrl) {
      return NextResponse.json({ error: "A valid URL is required" }, { status: 400 });
    }
    if (!isAllowedWebhookUrl(parsedUrl, WEBHOOK_DESTINATION)) {
      return NextResponse.json({ error: WEBHOOK_DESTINATION_REFUSED }, { status: 400 });
    }
    changes.url = parsedUrl;
  }
  if (updates.events !== undefined) {
    const parsedEvents = parseWebhookEvents(updates.events);
    if (!parsedEvents) {
      return NextResponse.json(
        { error: `events must be a list of: ${WEBHOOK_EVENTS.join(", ")}` },
        { status: 400 }
      );
    }
    changes.events = parsedEvents;
  }
  if (updates.enabled !== undefined) changes.enabled = !!updates.enabled;

  const before = await Project.findOneAndUpdate(
    { _id: projectId, "webhooks._id": webhookId },
    {
      $set: Object.fromEntries(
        Object.entries(changes).map(([field, value]) => [`webhooks.$.${field}`, value])
      ),
    },
    { returnDocument: "before" }
  ).lean();
  if (!before) {
    // Ambiguous on purpose the same way it always was: the project itself may be gone, or just
    // this webhook — one extra round trip only to tell those apart is not worth it here.
    return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
  }

  const was = (before.webhooks ?? []).find((w) => String(w._id) === webhookId);
  const webhooks = (before.webhooks ?? []).map((w) => (w === was ? { ...w, ...changes } : w));
  if (was) {
    const lines = webhookChanges(was, { ...was, ...changes });
    if (lines.length > 0) logProjectAudit(projectId, user._id, "settings_updated", lines);
  }

  return NextResponse.json(sanitizeProjectSecrets({ webhooks }).webhooks);
});

export const DELETE = withProjectOwner(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const webhookId = canonicalObjectId((await request.json()).webhookId);
  if (!webhookId) {
    return NextResponse.json({ error: "webhookId is required" }, { status: 400 });
  }

  const before = await Project.findOneAndUpdate(
    { _id: projectId },
    { $pull: { webhooks: { _id: webhookId } } },
    { returnDocument: "before" }
  ).lean();
  if (!before) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const removed = (before.webhooks ?? []).find((w) => String(w._id) === webhookId);
  if (removed) logProjectAudit(projectId, user._id, "settings_updated", `Webhook removed: ${maskSecretUrl(removed.url)}`);

  const webhooks = (before.webhooks ?? []).filter((w) => w !== removed);
  return NextResponse.json(sanitizeProjectSecrets({ webhooks }).webhooks);
});
