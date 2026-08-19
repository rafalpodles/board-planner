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

export const PUT = withAuth(async (request, { user }) => {
  await connectDB();

  const body = await request.json().catch(() => ({}));
  const updates: Record<string, unknown> = {
    "notifications.defaults": normaliseMatrix(body?.defaults),
  };

  if (body?.chat !== undefined) {
    const kind = body.chat?.kind;
    if (kind && !PERSONAL_CHAT_KINDS.includes(kind as PersonalChatKind)) {
      return NextResponse.json({ error: "Unknown chat service" }, { status: 400 });
    }
    updates["notifications.chat.kind"] = kind || "";

    const url = typeof body.chat?.webhookUrl === "string" ? body.chat.webhookUrl.trim() : "";
    if (url && url !== WEBHOOK_KEPT) {
      if (!isAllowedWebhookUrl(url)) {
        return NextResponse.json({ error: "That webhook address is not allowed" }, { status: 400 });
      }
      if (!isEncryptionConfigured()) {
        return NextResponse.json(
          { error: "This instance cannot store a webhook: ENCRYPTION_KEY is not set" },
          { status: 503 }
        );
      }
      updates["notifications.chat.webhookUrl"] = encryptSecret(url);
    } else if (!kind) {
      // Clearing the service clears the credential with it, rather than leaving one addressed to
      // a service nothing will read
      updates["notifications.chat.webhookUrl"] = "";
    }
  }

  await User.findByIdAndUpdate(user._id, { $set: updates });

  return NextResponse.json({ ok: true });
});
