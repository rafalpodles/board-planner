import { Notification } from "@/models/notification";
import { User } from "@/models/user";
import { NotificationType } from "@/types";
import { resolveChannels } from "@/lib/notification-prefs";
import { sendPersonalChat, PersonalChatRecipient } from "@/lib/personal-chat";
import { Types } from "mongoose";
import { sendEmail, isEmailConfigured } from "@/lib/email";
import { APP_NAME } from "@/lib/brand";
import { Pill, renderEmail } from "@/lib/email-template";
import { selfOrigin } from "@/lib/session";
import { taskPath } from "@/lib/urls";
import { recipientsWithAccess } from "@/lib/grants";

export interface NotificationEmail {
  kicker: string;
  taskKey: string;
  taskTitle: string;
  taskPills?: Pill[];
  taskMeta?: string;
  quote?: { who: string; text: string };
  projectRef?: string;
  taskNumber?: number;
  assigneeId?: string;
}

type MailRecipient = { _id: unknown; email: string; fullName?: string };

interface NotifyParams {
  type: NotificationType;
  taskId: string;
  projectId: string;
  actorId: string;
  title: string;
  body?: string;
  recipientIds: string[];
  email?: NotificationEmail;
}

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

export async function createNotifications(params: NotifyParams): Promise<void> {
  try {
    await notify(params);
  } catch (err) {
    console.error("Failed to notify:", err);
  }
}

async function notify({
  type,
  taskId,
  projectId,
  actorId,
  title,
  body,
  recipientIds,
  email,
}: NotifyParams): Promise<void> {
  const named = [...new Set(recipientIds)].filter((id) => id && id !== actorId);
  const unique = named.filter((id) => OBJECT_ID.test(id));
  if (unique.length < named.length) {
    console.error(
      `Skipped ${named.length - unique.length} notification recipient(s) that are not ids`
    );
  }
  if (unique.length === 0) return;

  let allowed: string[];
  try {
    allowed = await recipientsWithAccess(unique, projectId);
  } catch (err) {
    console.error("Failed to resolve notification recipients:", err);
    return;
  }
  if (allowed.length === 0) return;

  const recipients = await User.find(
    { _id: { $in: allowed.map((id) => new Types.ObjectId(id)) } },
    "email fullName emailNotifications emailDigest notifications"
  ).lean();

  const wants = new Map(
    recipients.map((user) => [String(user._id).toLowerCase(), resolveChannels(user, projectId, type)])
  );

  const shown = (recipientId: string) => wants.get(recipientId.toLowerCase())?.inApp ?? true;

  try {
    await Notification.insertMany(
      allowed.map((recipientId) => ({
        recipient: new Types.ObjectId(recipientId),
        type,
        task: new Types.ObjectId(taskId),
        project: new Types.ObjectId(projectId),
        actor: new Types.ObjectId(actorId),
        title,
        body: body || "",
        inApp: shown(recipientId),
        hiddenAt: shown(recipientId) ? undefined : new Date(),
      }))
    );
  } catch (err) {
    console.error("Failed to create in-app notifications:", err);
  }

  if (isEmailConfigured()) {
    const mailTo = recipients.filter((user) => {
      if (!wants.get(String(user._id).toLowerCase())?.email) return false;
      if (!user.email) return false;
      return !user.emailDigest;
    });
    if (mailTo.length > 0) {
      sendEmailNotifications({ users: mailTo, type, title, body: body || "", email }).catch((err) =>
        console.error("Failed to send email notifications:", err)
      );
    }
  }

  const chatTo = recipients.filter(
    (user) => wants.get(String(user._id).toLowerCase())?.chat && user.notifications?.chat?.kind
  );
  if (chatTo.length > 0) {
    sendPersonalChat({ users: chatTo, type, title, email }).catch((err) =>
      console.error("Failed to send chat notifications:", err)
    );
  }
}

function reasonFor(
  type: NotificationType,
  taskKey: string,
  isAssignee: boolean
): string {
  switch (type) {
    case "task_assigned":
      return `You're getting this because ${taskKey} was assigned to you.`;
    case "mentioned":
      return `You're getting this because you were mentioned in a comment on ${taskKey}.`;
    case "task_created":
      return "You're getting this because you asked to hear about every task created on this board.";
    default:
      return isAssignee
        ? `You're getting this because you're the assignee on ${taskKey}.`
        : `You're getting this because you watch ${taskKey}.`;
  }
}

async function sendEmailNotifications(n: {
  users: MailRecipient[];
  type: NotificationType;
  title: string;
  body: string;
  email?: NotificationEmail;
}): Promise<void> {
  const users = n.users;
  if (users.length === 0) return;

  const origin = selfOrigin();
  const e = n.email;
  const taskUrl =
    origin && e?.projectRef && e?.taskNumber !== undefined
      ? `${origin}${taskPath(e.projectRef, e.taskNumber)}`
      : undefined;
  const settingsUrl = origin ? `${origin}/settings/notifications` : undefined;

  for (const user of users) {
    const taskKey = e?.taskKey ?? "";
    const reason = e
      ? reasonFor(n.type, taskKey, !!e.assigneeId && e.assigneeId === String(user._id))
      : n.title;

    const { html, text } = renderEmail({
      preheader: n.body || n.title,
      kicker: e?.kicker ?? APP_NAME,
      heading: e ? undefined : n.title,
      intro: e || !n.body ? undefined : [n.body],
      taskCard: e
        ? {
            key: e.taskKey,
            title: e.taskTitle,
            url: taskUrl,
            pills: e.taskPills,
            meta: e.taskMeta,
          }
        : undefined,
      quote: e?.quote,
      button: taskUrl ? { label: `Open ${e?.taskKey ?? "the task"}`, url: taskUrl } : undefined,
      secondaryButton:
        n.type === "task_assigned" && origin
          ? { label: "See my tasks", url: `${origin}/my-tasks` }
          : undefined,
      footer: [reason],
      footerLinks: settingsUrl
        ? [{ label: "Email notification settings", url: settingsUrl }]
        : undefined,
    });

    sendEmail({
      to: user.email,
      subject: `[${APP_NAME}] ${n.title}`,
      text,
      html,
      headers: settingsUrl ? { "List-Unsubscribe": `<${settingsUrl}>` } : undefined,
    }).catch(() => {});
  }
}

export function assigneeIdOf(task: { assignee?: { _id?: unknown } | unknown }): string | undefined {
  if (!task.assignee) return undefined;
  return typeof task.assignee === "object" && task.assignee !== null && "_id" in task.assignee
    ? String((task.assignee as { _id: unknown })._id)
    : String(task.assignee);
}

export function collectRecipients(task: {
  assignee?: { _id?: unknown } | unknown;
  watchers?: unknown[];
}): string[] {
  const ids: string[] = [];

  const assigneeId = assigneeIdOf(task);
  if (assigneeId) {
    ids.push(assigneeId);
  }

  if (task.watchers) {
    for (const w of task.watchers) {
      ids.push(String(w));
    }
  }

  return ids;
}

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
