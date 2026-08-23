import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { User } from "@/models/user";
import { defaultMatrix, normaliseMatrix } from "@/lib/notification-prefs";
import { PERSONAL_CHAT_KINDS, PersonalChatKind } from "@/types";
import { encryptSecret, isEncryptionConfigured } from "@/lib/encryption";
import { isAllowedWebhookUrl } from "@/lib/url-validation";

const WEBHOOK_KEPT = "__kept__";

export const GET = withAuth(async (_request, { user }) => {
  await connectDB();

  const stored = await User.findById(user._id, "emailNotifications notifications").lean();

  return NextResponse.json({
    defaults: defaultMatrix(stored),
    // Absent means the account has never saved: the screen shows the same values either way, but
    // it is the difference between "these are my settings" and "these are what you had before"
    configured: !!stored?.notifications?.defaults,
    projects: (stored?.notifications?.projects ?? []).map((p) => ({
      project: String(p.project),
      matrix: p.matrix,
    })),
    chat: {
      kind: stored?.notifications?.chat?.kind ?? "",
      // The URL is a credential and never travels back — the screen only needs to know there is one
      configured: !!stored?.notifications?.chat?.webhookUrl,
    },
  });
});

/** What the connection will be once this request is applied — never a flag carried between branches. */
interface ChatOutcome {
  /** Field writes this outcome implies. Empty when the request said nothing about the connection. */
  writes: Record<string, string>;
}

type Refusal = { error: string; status: number };

/**
 * The connection is decided once, from the stored state and the request. Nothing else in the
 * document depends on the answer: whether chat may deliver is derived at read time by
 * resolveChannels, so this function writes two fields and nothing more.
 */
function resolveChat(
  body: unknown,
  storedChat: { kind?: string; webhookUrl?: string } | undefined
): ChatOutcome | Refusal {
  const chat = (body as { chat?: unknown })?.chat;
  // Absent says nothing about the connection, and neither does a value that is not an object.
  // Reading either as "disconnect me" once deleted a stored credential on a 200.
  if (chat === undefined || chat === null) return { writes: {} };
  const isObject = chat !== null && typeof chat === "object" && !Array.isArray(chat);
  if (!isObject) {
    return { error: "chat must be an object", status: 400 };
  }

  const fields = chat as { kind?: unknown; webhookUrl?: unknown };
  // Disconnecting is saying so, not omitting it: `{}` from a partial-update client must not erase
  // a credential that cannot be recovered.
  if (!("kind" in fields)) {
    return fields.webhookUrl === undefined
      ? { writes: {} }
      : { error: "Choose Slack or Discord for that address", status: 400 };
  }

  const named = typeof fields.kind === "string" ? fields.kind : "";
  if (named && !PERSONAL_CHAT_KINDS.includes(named as PersonalChatKind)) {
    return { error: "Unknown chat service", status: 400 };
  }
  const kind = named as PersonalChatKind | "";

  const raw = typeof fields.webhookUrl === "string" ? fields.webhookUrl.trim() : "";
  const keeping = raw === WEBHOOK_KEPT;
  const url = keeping ? "" : raw;

  if (!kind) {
    // Clearing the service clears the credential with it, whatever else the request carried: a
    // screen that hides its address field on deselect cannot be asked to send a coherent pair.
    return { writes: { kind: "", webhookUrl: "" } };
  }

  const sameService = kind === storedChat?.kind;
  if (!url) {
    // Naming a service with no new address is only meaningful if that service already has one.
    // Switching service while keeping the old address posts one service's payload shape at the
    // other's endpoint forever, with the screen still reporting a healthy connection.
    if (!sameService) {
      return { error: "That service needs its own webhook address", status: 400 };
    }
    // Re-stating the connection exactly as it stands. Writing `kind` again is harmless.
    return { writes: { kind } };
  }

  if (!isAllowedWebhookUrl(url)) {
    return { error: "That webhook address is not allowed", status: 400 };
  }
  if (!isEncryptionConfigured()) {
    return {
      error: "This instance cannot store a webhook: ENCRYPTION_KEY is not set",
      status: 503,
    };
  }
  return { writes: { kind, webhookUrl: encryptSecret(url) } };
}

function isRefusal(outcome: ChatOutcome | Refusal): outcome is Refusal {
  return "error" in outcome;
}

export const PUT = withAuth(async (request, { user }) => {
  // One rule, before anything is read or validated: a machine credential does not touch these.
  // Stated as "may not install an address" it kept slipping — a token could switch the column on
  // against an address the owner had already stored, or widen it row by row, or drop an override
  // that was muting a board, each a standing outbound copy reached by a different verb. Nothing in
  // this repo edits notification preferences with a token, so the whole surface is withheld and
  // there is one thing to audit rather than four conditions to keep in agreement.
  if (user.viaMachineCredential) {
    return NextResponse.json(
      { error: "This action requires an interactive session" },
      { status: 403 }
    );
  }

  await connectDB();

  const body = await request.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};

  // Only what the request carried, and only if it carried a grid rather than a null standing in
  // for one: normaliseMatrix(null) is an all-off grid, so accepting it would silence every row on
  // every channel for a client that merely serialises a missing field as null.
  if (body?.defaults !== undefined && body?.defaults !== null) {
    updates["notifications.defaults"] = normaliseMatrix(body.defaults);
  }

  const stored = await User.findById(user._id, "notifications.chat").lean();
  const chat = resolveChat(body, stored?.notifications?.chat);
  if (isRefusal(chat)) {
    return NextResponse.json({ error: chat.error }, { status: chat.status });
  }
  for (const [field, value] of Object.entries(chat.writes)) {
    updates[`notifications.chat.${field}`] = value;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  await User.findByIdAndUpdate(user._id, { $set: updates });

  return NextResponse.json({ ok: true });
});
