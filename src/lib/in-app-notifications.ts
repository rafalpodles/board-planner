import { Notification } from "@/models/notification";
import { User } from "@/models/user";
import { NotificationType } from "@/types";
import { Types } from "mongoose";
import { sendEmail, isEmailConfigured } from "@/lib/email";

interface NotifyParams {
  type: NotificationType;
  taskId: string;
  projectId: string;
  actorId: string;
  title: string;
  body?: string;
  recipientIds: string[];
}

/**
 * Create in-app notifications for a list of recipients,
 * excluding the actor (you don't notify yourself).
 */
export async function createNotifications({
  type,
  taskId,
  projectId,
  actorId,
  title,
  body,
  recipientIds,
}: NotifyParams): Promise<void> {
  // Deduplicate and exclude actor
  const unique = [...new Set(recipientIds)].filter(
    (id) => id && id !== actorId
  );
  if (unique.length === 0) return;

  try {
    await Notification.insertMany(
      unique.map((recipientId) => ({
        recipient: new Types.ObjectId(recipientId),
        type,
        task: new Types.ObjectId(taskId),
        project: new Types.ObjectId(projectId),
        actor: new Types.ObjectId(actorId),
        title,
        body: body || "",
      }))
    );
  } catch (err) {
    console.error("Failed to create in-app notifications:", err);
  }

  // Fire-and-forget email notifications
  if (isEmailConfigured()) {
    sendEmailNotifications(unique, title, body || "").catch((err) =>
      console.error("Failed to send email notifications:", err)
    );
  }
}

async function sendEmailNotifications(
  recipientIds: string[],
  subject: string,
  body: string
): Promise<void> {
  const users = await User.find(
    {
      _id: { $in: recipientIds.map((id) => new Types.ObjectId(id)) },
      emailNotifications: true,
      email: { $ne: "" },
    },
    "email fullName"
  ).lean();

  for (const user of users) {
    sendEmail({
      to: user.email,
      subject: `[ClaudePlanner] ${subject}`,
      text: body ? `${subject}\n\n${body}` : subject,
      html: `<p><strong>${escapeHtml(subject)}</strong></p>${body ? `<p>${escapeHtml(body)}</p>` : ""}`,
    }).catch(() => {});
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Collect recipient IDs from task assignee + watchers.
 */
export function collectRecipients(task: {
  assignee?: { _id?: unknown } | unknown;
  watchers?: unknown[];
}): string[] {
  const ids: string[] = [];

  if (task.assignee) {
    const assigneeId =
      typeof task.assignee === "object" && task.assignee !== null && "_id" in task.assignee
        ? String((task.assignee as { _id: unknown })._id)
        : String(task.assignee);
    ids.push(assigneeId);
  }

  if (task.watchers) {
    for (const w of task.watchers) {
      ids.push(String(w));
    }
  }

  return ids;
}

/**
 * Parse @mentions from comment body and resolve to user IDs.
 */
export async function resolveMentions(body: string): Promise<string[]> {
  const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
  const usernames: string[] = [];
  let match;
  while ((match = mentionRegex.exec(body)) !== null) {
    usernames.push(match[1].toLowerCase());
  }
  if (usernames.length === 0) return [];

  const users = await User.find(
    { username: { $in: usernames } },
    "_id"
  ).lean();
  return users.map((u) => String(u._id));
}
