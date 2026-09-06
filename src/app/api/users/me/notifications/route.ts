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
    configured: !!stored?.notifications?.defaults,
    projects: (stored?.notifications?.projects ?? []).map((p) => ({
      project: String(p.project),
      matrix: p.matrix,
    })),
    chat: {
      kind: stored?.notifications?.chat?.kind ?? "",
      configured: !!stored?.notifications?.chat?.webhookUrl,
    },
  });
});

interface ChatOutcome {
  writes: Record<string, string>;
}

type Refusal = { error: string; status: number };

function resolveChat(
  body: unknown,
  storedChat: { kind?: string; webhookUrl?: string } | undefined
): ChatOutcome | Refusal {
  const chat = (body as { chat?: unknown })?.chat;
  if (chat === undefined || chat === null) return { writes: {} };
  const isObject = chat !== null && typeof chat === "object" && !Array.isArray(chat);
  if (!isObject) {
    return { error: "chat must be an object", status: 400 };
  }

  const fields = chat as { kind?: unknown; webhookUrl?: unknown };
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
    return { writes: { kind: "", webhookUrl: "" } };
  }

  const sameService = kind === storedChat?.kind;
  if (!url) {
    if (!sameService) {
      return { error: "That service needs its own webhook address", status: 400 };
    }
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
  if (user.viaMachineCredential) {
    return NextResponse.json(
      { error: "This action requires an interactive session" },
      { status: 403 }
    );
  }

  await connectDB();

  const body = await request.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};

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
