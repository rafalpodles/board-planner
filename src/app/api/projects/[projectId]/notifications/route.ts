import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { Project } from "@/models/project";
import { logProjectAudit } from "@/lib/projectAudit";
import { channelChanges } from "@/lib/settings-audit";
import { canonicalObjectId } from "@/lib/object-id";
import { NOTIFICATION_CHANNEL_TYPES, WEBHOOK_EVENTS, NotificationChannelType } from "@/types";
import { sanitizeProjectSecrets } from "@/lib/project-secrets";
import { parseWebhookUrl, parseWebhookEvents, MAX_CHANNEL_NAME_LENGTH, MAX_NOTIFICATION_CHANNELS } from "@/lib/webhook-input";
import { isAllowedWebhookUrl, WEBHOOK_DESTINATION, WEBHOOK_DESTINATION_REFUSED } from "@/lib/url-validation";
import { decryptSecret, encryptSecret, isEncryptedSecret, isEncryptionConfigured } from "@/lib/encryption";

// Built per call: a Response's body is a one-shot stream, so one shared instance answers the
// second caller with no body at all and two concurrent ones with a locked stream.
const noKey = () =>
  NextResponse.json(
    { error: "This instance cannot store a webhook URL: ENCRYPTION_KEY is not set" },
    { status: 503 }
  );

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function masked(project: any) {
  return sanitizeProjectSecrets(typeof project.toObject === "function" ? project.toObject() : project)
    .notificationChannels || [];
}

function storedUrl(value: string | undefined): string | null {
  if (!value) return null;
  if (!isEncryptedSecret(value)) return value;
  try {
    return decryptSecret(value);
  } catch {
    return null;
  }
}

export const GET = withProjectOwner(async (_request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const project = await Project.findById(projectId, "key notificationChannels");
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
  if (!isAllowedWebhookUrl(parsedUrl, WEBHOOK_DESTINATION)) {
    return NextResponse.json({ error: WEBHOOK_DESTINATION_REFUSED }, { status: 400 });
  }

  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  if (name.trim().length > MAX_CHANNEL_NAME_LENGTH) {
    return NextResponse.json({ error: `Name must be at most ${MAX_CHANNEL_NAME_LENGTH} characters` }, { status: 400 });
  }

  const parsedEvents = events === undefined ? [...WEBHOOK_EVENTS] : parseWebhookEvents(events);
  if (!parsedEvents) {
    return NextResponse.json(
      { error: `events must be a list of: ${WEBHOOK_EVENTS.join(", ")}` },
      { status: 400 }
    );
  }

  if (!isEncryptionConfigured()) return noKey();

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // The ceiling goes in the write's own filter, not in a count read against the document
  // above: every concurrent racer sees the same pre-write length, so a check up there
  // bounds nothing — the same fix already applied to the webhook writers (BP-719).
  const updated = await Project.findOneAndUpdate(
    { _id: projectId, [`notificationChannels.${MAX_NOTIFICATION_CHANNELS - 1}`]: { $exists: false } },
    {
      $push: {
        notificationChannels: {
          type: type as NotificationChannelType,
          name: name.trim(),
          webhookUrl: encryptSecret(parsedUrl),
          events: parsedEvents,
          enabled: true,
        },
      },
    },
    { returnDocument: "after" }
  );
  if (!updated) {
    // The project was read a moment ago, so ordinarily a miss here is the ceiling — but it can
    // also mean the project was deleted in between, and the two answer differently (review).
    if (await Project.exists({ _id: projectId })) {
      return NextResponse.json(
        { error: `A project can have at most ${MAX_NOTIFICATION_CHANNELS} chat channels` },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  logProjectAudit(projectId, user._id, "settings_updated", `Notification channel added: ${name.trim()} (${type})`);

  return NextResponse.json(masked(updated), { status: 201 });
});

export const PUT = withProjectOwner(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const { channelId: rawChannelId, ...updates } = await request.json();
  const channelId = canonicalObjectId(rawChannelId);
  if (!channelId) {
    return NextResponse.json({ error: "channelId is required" }, { status: 400 });
  }

  const changes: { name?: string; webhookUrl?: string; events?: string[]; enabled?: boolean } = {};
  let newUrl: string | null = null;
  if (updates.name !== undefined) {
    if (typeof updates.name !== "string" || !updates.name.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    if (updates.name.trim().length > MAX_CHANNEL_NAME_LENGTH) {
      return NextResponse.json({ error: `Name must be at most ${MAX_CHANNEL_NAME_LENGTH} characters` }, { status: 400 });
    }
    changes.name = updates.name.trim();
  }
  if (updates.webhookUrl !== undefined) {
    const parsedUrl = parseWebhookUrl(updates.webhookUrl);
    if (!parsedUrl) {
      return NextResponse.json({ error: "A valid webhook URL is required" }, { status: 400 });
    }
    if (!isAllowedWebhookUrl(parsedUrl, WEBHOOK_DESTINATION)) {
      return NextResponse.json({ error: WEBHOOK_DESTINATION_REFUSED }, { status: 400 });
    }
    if (!isEncryptionConfigured()) return noKey();
    newUrl = parsedUrl;
    changes.webhookUrl = encryptSecret(parsedUrl);
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

  // One positional write rather than load, mutate, save(): save() sent the whole list back, so a
  // channel added or edited meanwhile was put back the way this request had read it
  const before = await Project.findOneAndUpdate(
    { _id: projectId, "notificationChannels._id": channelId },
    {
      $set: Object.fromEntries(
        Object.entries(changes).map(([field, value]) => [`notificationChannels.$.${field}`, value])
      ),
    },
    { returnDocument: "before" }
  ).lean();
  if (!before) {
    if (await Project.exists({ _id: projectId })) {
      return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const channels = before.notificationChannels ?? [];
  const was = channels.find((ch) => String(ch._id) === channelId)!;
  let is = { ...was, ...changes };

  // Rows written before BP-372 hold the URL in the clear. Any save on the channel carries them
  // over, so renaming one is enough to migrate it — but only the value this save read
  if (!changes.webhookUrl && was.webhookUrl && !isEncryptedSecret(was.webhookUrl) && isEncryptionConfigured()) {
    const sealed = encryptSecret(was.webhookUrl);
    const migrated = await Project.updateOne(
      {
        _id: projectId,
        notificationChannels: { $elemMatch: { _id: channelId, webhookUrl: was.webhookUrl } },
      },
      { $set: { "notificationChannels.$.webhookUrl": sealed } }
    );
    if (migrated.modifiedCount > 0) is = { ...is, webhookUrl: sealed };
  }

  const lines = channelChanges(was, is, newUrl !== null && newUrl !== storedUrl(was.webhookUrl));
  if (lines.length > 0) logProjectAudit(projectId, user._id, "settings_updated", lines);

  const notificationChannels = channels.map((ch) => (ch === was ? is : ch));
  return NextResponse.json(masked({ _id: before._id, key: before.key, notificationChannels }));
});

export const DELETE = withProjectOwner(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const channelId = canonicalObjectId((await request.json()).channelId);
  if (!channelId) {
    return NextResponse.json({ error: "channelId is required" }, { status: 400 });
  }

  const before = await Project.findOneAndUpdate(
    { _id: projectId },
    { $pull: { notificationChannels: { _id: channelId } } },
    { returnDocument: "before" }
  ).lean();
  if (!before) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const channels = before.notificationChannels ?? [];
  const removed = channels.find((ch) => String(ch._id) === channelId);
  if (removed) {
    logProjectAudit(projectId, user._id, "settings_updated", `Notification channel removed: ${removed.name}`);
  }

  const notificationChannels = channels.filter((ch) => ch !== removed);
  return NextResponse.json(masked({ _id: before._id, key: before.key, notificationChannels }));
});
