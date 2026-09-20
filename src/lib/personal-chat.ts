import { NotificationType, PersonalChatKind } from "@/types";
import { isAllowedWebhookUrl } from "./url-validation";
import { safeFetch } from "./safe-fetch";
import { OUTBOUND_CONCURRENCY, runBounded } from "./bounded";
import { decryptSecret } from "./encryption";
import { selfOrigin } from "./session";
import { taskPath } from "./urls";
import { DISCORD_NO_MENTIONS, escapeDiscord, escapeSlack } from "./chat-markup";
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
  task_linked: "A dependency changed on a task you follow",
  // Not the project channel's "New task created in <board>": that announces a board to a room,
  // this is addressed to one person who asked to watch the board rather than a task.
  task_created: "New task on a board you watch",
};

function line(type: NotificationType, title: string, url?: string): string {
  const safe = escapeSlack(title);
  const subject = url ? `<${escapeSlack(url)}|${safe}>` : safe;
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
  const safe = escapeDiscord(title);
  const content = url ? `**${HEADLINE[type]}**\n${safe}\n${url}` : `**${HEADLINE[type]}**\n${safe}`;
  return JSON.stringify({ content, allowed_mentions: DISCORD_NO_MENTIONS });
}

export async function sendPersonalChat(n: {
  users: PersonalChatRecipient[];
  type: NotificationType;
  title: string;
  email?: NotificationEmail;
}): Promise<void> {
  const url = urlFor(n.email);

  const recipients = n.users.filter(
    (user) => user.notifications?.chat?.kind && user.notifications?.chat?.webhookUrl
  );
  void runBounded(recipients, OUTBOUND_CONCURRENCY, async (user) => {
    const kind = user.notifications!.chat!.kind as PersonalChatKind;
    const stored = user.notifications!.chat!.webhookUrl!;

    let webhookUrl: string;
    try {
      webhookUrl = decryptSecret(stored);
    } catch {
      // A key rotation that lost the old key leaves an undecryptable value. Skipping is the only
      // safe answer: the alternative is posting the ciphertext at some URL.
      console.error("Personal chat webhook could not be decrypted");
      return;
    }
    if (!isAllowedWebhookUrl(webhookUrl)) return;

    await safeFetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyFor(kind, n.type, n.title, url),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {
      // Delivery failures are not the notification's problem, same as the project channels
    });
  });
}
