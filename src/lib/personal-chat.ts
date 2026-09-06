import { NotificationType, PersonalChatKind } from "@/types";
import { isAllowedWebhookUrl } from "./url-validation";
import { safeFetch } from "./safe-fetch";
import { decryptSecret } from "./encryption";
import { selfOrigin } from "./session";
import { taskPath } from "./urls";
import type { NotificationEmail } from "./in-app-notifications";

export interface PersonalChatRecipient {
  _id: unknown;
  notifications?: { chat?: { kind?: PersonalChatKind | ""; webhookUrl?: string } } | null;
}

const HEADLINE: Record<NotificationType, string> = {
  task_assigned: "Assigned to you",
  mentioned: "You were mentioned",
  status_changed: "A task you follow moved",
  comment_added: "New comment on a task you follow",
  task_created: "New task on a board you watch",
};

function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function line(type: NotificationType, title: string, url?: string): string {
  const safe = escapeSlack(title);
  const subject = url ? `<${escapeSlack(url)}|${safe}>` : safe;
  return `*${HEADLINE[type]}*\n${subject}`;
}

function escapeDiscord(text: string): string {
  return text.replace(/([*_~`|\\>])/g, "\\$1");
}

function urlFor(email?: NotificationEmail): string | undefined {
  const origin = selfOrigin();
  if (!origin || !email?.projectRef || email.taskNumber === undefined) return undefined;
  return `${origin}${taskPath(email.projectRef, email.taskNumber)}`;
}

function bodyFor(
  kind: PersonalChatKind,
  type: NotificationType,
  title: string,
  url?: string
): string {
  if (kind === "slack") return JSON.stringify({ text: line(type, title, url) });
  const safe = escapeDiscord(title);
  const content = url ? `**${HEADLINE[type]}**\n${safe}\n${url}` : `**${HEADLINE[type]}**\n${safe}`;
  return JSON.stringify({ content, allowed_mentions: { parse: [] } });
}

export async function sendPersonalChat(n: {
  users: PersonalChatRecipient[];
  type: NotificationType;
  title: string;
  email?: NotificationEmail;
}): Promise<void> {
  const url = urlFor(n.email);

  for (const user of n.users) {
    const kind = user.notifications?.chat?.kind;
    const stored = user.notifications?.chat?.webhookUrl;
    if (!kind || !stored) continue;

    let webhookUrl: string;
    try {
      webhookUrl = decryptSecret(stored);
    } catch {
      console.error("Personal chat webhook could not be decrypted");
      continue;
    }
    if (!isAllowedWebhookUrl(webhookUrl)) continue;

    safeFetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyFor(kind, n.type, n.title, url),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {
    });
  }
}
