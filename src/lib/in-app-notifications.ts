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

/**
 * What the mail version of a notification shows beyond the one-line title the in-app list uses.
 * Assembled by the caller, which is the only place that holds the project's column labels, the
 * actor's name and the task number the link needs.
 */
export interface NotificationEmail {
  kicker: string;
  taskKey: string;
  taskTitle: string;
  taskPills?: Pill[];
  taskMeta?: string;
  quote?: { who: string; text: string };
  /** Project key (or id) and task number — together they make the link back into the board. */
  projectRef?: string;
  taskNumber?: number;
  /** Lets the footer tell an assignee why they got this without a second query per recipient. */
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

/**
 * Create in-app notifications for a list of recipients,
 * excluding the actor (you don't notify yourself).
 */
export async function createNotifications(params: NotifyParams): Promise<void> {
  // Callers fire this and walk away — none of them awaits it. An exception escaping here is an
  // unhandled rejection, which ends the process, so the whole body is guarded rather than the one
  // write that used to be.
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
  // Deduplicate and exclude actor
  const named = [...new Set(recipientIds)].filter((id) => id && id !== actorId);
  // A recipient that is not an id can be neither stored nor looked up, and casting one throws.
  // Every writer calls this without awaiting it, so a throw here is an unhandled rejection rather
  // than a failed notification — dropping the bad entry keeps the good ones and the request alive.
  const unique = named.filter((id) => OBJECT_ID.test(id));
  if (unique.length < named.length) {
    console.error(
      `Skipped ${named.length - unique.length} notification recipient(s) that are not ids`
    );
  }
  if (unique.length === 0) return;

  // Two questions, both of which have to be asked. May this person still see the board? Watchers
  // accumulate by commenting and outlive the grant that justified them, so it is decided here
  // rather than trusted from the task (BP-328), and an error refuses rather than delivers: a
  // dropped notification is recoverable, a leaked task title is not.
  let allowed: string[];
  try {
    allowed = await recipientsWithAccess(unique, projectId);
  } catch (err) {
    console.error("Failed to resolve notification recipients:", err);
    return;
  }
  if (allowed.length === 0) return;

  // And: did they ask to hear about it? One read of the preferences of the people who passed the
  // first question, then one decision each. This used to be a clause inside the recipient query,
  // which is why nothing could depend on the project or the event; resolveChannels can.
  const recipients = await User.find(
    { _id: { $in: allowed.map((id) => new Types.ObjectId(id)) } },
    "email fullName emailNotifications emailDigest notifications"
  ).lean();

  const wants = new Map(
    // Lower-cased on both sides: OBJECT_ID accepts upper-case hex, and a miss here would
    // silently fall back to "show it", which is the opposite of what the reader asked for.
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
        // Stored regardless, hidden if the bell is off for this row: the digest reads these
        // documents, and skipping the write would take the morning mail down with the bell.
        inApp: shown(recipientId),
        // Stamped only when hidden, so the TTL that collects these can key on its presence
        hiddenAt: shown(recipientId) ? undefined : new Date(),
      }))
    );
  } catch (err) {
    console.error("Failed to create in-app notifications:", err);
  }

  // Fire-and-forget email notifications
  if (isEmailConfigured()) {
    const mailTo = recipients.filter((user) => {
      if (!wants.get(String(user._id).toLowerCase())?.email) return false;
      if (!user.email) return false;
      // Somebody on the digest hears about this tomorrow morning, in one message. Sending both
      // would make the digest a duplicate rather than a replacement.
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

  // Without a configured origin there is no address to link to. The mail still goes out, just
  // without the button — the alternative is a link to a build-machine literal (BP-316).
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
      // One-click opt-out lives on the profile page; without the header a mail client offers the
      // reader the spam button instead, which costs the whole deployment its deliverability.
      headers: settingsUrl ? { "List-Unsubscribe": `<${settingsUrl}>` } : undefined,
    }).catch(() => {});
  }
}

/** The assignee's id, whether the field is populated or a bare ref. */
export function assigneeIdOf(task: { assignee?: { _id?: unknown } | unknown }): string | undefined {
  if (!task.assignee) return undefined;
  return typeof task.assignee === "object" && task.assignee !== null && "_id" in task.assignee
    ? String((task.assignee as { _id: unknown })._id)
    : String(task.assignee);
}

/**
 * Collect recipient IDs from task assignee + watchers.
 */
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
