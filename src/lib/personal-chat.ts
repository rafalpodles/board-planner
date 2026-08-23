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

/**
 * A personal channel is not the project channel with a different URL. The project's messages
 * announce a board to a room — "New task created in Board Planner" — while these are addressed to
 * one person who asked to hear about their own work, so they say "you".
 */
const HEADLINE: Record<NotificationType, string> = {
  task_assigned: "Assigned to you",
  mentioned: "You were mentioned",
  status_changed: "A task you follow moved",
  comment_added: "New comment on a task you follow",
};

/**
 * Slack reads `<url|text>` as a link, so a title carrying `>` closes it and anything after can
 * open a second link the reader has no reason to distrust — in their own private channel, from a
 * sender they trust. Escaping the three characters Slack treats as markup is the documented fix.
 */
function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function line(type: NotificationType, title: string, url?: string): string {
  const safe = escapeSlack(title);
  const subject = url ? `<${url}|${safe}>` : safe;
  return `*${HEADLINE[type]}*\n${subject}`;
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
  // Discord has no link syntax inside content, so the URL goes on its own line and unfurls
  const content = url ? `**${HEADLINE[type]}**\n${title}\n${url}` : `**${HEADLINE[type]}**\n${title}`;
  return JSON.stringify({ content });
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
      // A key rotation that lost the old key leaves an undecryptable value. Skipping is the only
      // safe answer: the alternative is posting the ciphertext at some URL.
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
      // Delivery failures are not the notification's problem, same as the project channels
    });
  }
}
