import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { User } from "@/models/user";
import { defaultMatrix, normaliseMatrix, wantsChat, blankMatrix } from "@/lib/notification-prefs";
import { NOTIFICATION_TYPES, PERSONAL_CHAT_KINDS, PersonalChatKind } from "@/types";
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
  const updates: Record<string, unknown> = {};

  // Only what the request carried, and only if it carried a grid rather than a null standing in
  // for one: normaliseMatrix(null) is an all-off grid, so accepting it would silence every row on
  // every channel for a client that merely serialises a missing field as null.
  const sentGrid = body?.defaults !== undefined && body?.defaults !== null;
  if (sentGrid) {
    updates["notifications.defaults"] = normaliseMatrix(body.defaults);
  }

  const stored = await User.findById(user._id, "notifications").lean();
  const storedChat = stored?.notifications?.chat;
  let chatAfter = { kind: storedChat?.kind ?? "", hasUrl: !!storedChat?.webhookUrl };

  if (body?.chat !== undefined && body?.chat !== null) {
    const kind = body.chat?.kind;
    if (kind && !PERSONAL_CHAT_KINDS.includes(kind as PersonalChatKind)) {
      return NextResponse.json({ error: "Unknown chat service" }, { status: 400 });
    }
    updates["notifications.chat.kind"] = kind || "";

    const raw = typeof body.chat?.webhookUrl === "string" ? body.chat.webhookUrl.trim() : "";
    const keeping = raw === WEBHOOK_KEPT;
    const url = keeping ? "" : raw;

    // Switching service while keeping the old address posts one service's payload shape at the
    // other's endpoint, forever, with the screen still reporting a healthy connection. Anything
    // that does not supply a new address for a new service is refused, not just the sentinel.
    if (kind && kind !== storedChat?.kind && !url) {
      return NextResponse.json(
        { error: "That service needs its own webhook address" },
        { status: 400 }
      );
    }

    if (url) {
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
      chatAfter = { kind: kind || "", hasUrl: true };
    } else if (!kind) {
      // Clearing the service clears the credential with it, rather than leaving one addressed to
      // a service nothing will read
      updates["notifications.chat.webhookUrl"] = "";
      chatAfter = { kind: "", hasUrl: false };
    } else {
      chatAfter = { kind, hasUrl: keeping && !!storedChat?.webhookUrl };
    }
  }

  // Delivery needs a service AND an address; either alone sends nothing and says nothing. Checking
  // `kind` alone let one request store a kind with no webhook and tick the column against it.
  const connected = !!chatAfter.kind && chatAfter.hasUrl;
  if (!connected) {
    // Disconnecting is allowed — it just cannot leave a column ticked that now delivers nowhere,
    // in the grid being written OR in one already stored, including every project override. Those
    // are cleared here rather than refused, because refusing left people unable to save at all.
    const grid = (updates["notifications.defaults"] ??
      defaultMatrix(stored)) as ReturnType<typeof blankMatrix>;
    if (wantsChat(grid)) {
      updates["notifications.defaults"] = withoutChat(grid);
    }
    const overrides = stored?.notifications?.projects ?? [];
    if (overrides.some((p) => wantsChat(p.matrix))) {
      updates["notifications.projects"] = overrides.map((p) => ({
        project: p.project,
        matrix: withoutChat(p.matrix),
      }));
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  await User.findByIdAndUpdate(user._id, { $set: updates });

  return NextResponse.json({ ok: true, chatConnected: connected });
});

function withoutChat<T extends ReturnType<typeof blankMatrix>>(matrix: T): T {
  const next = { ...matrix };
  for (const type of NOTIFICATION_TYPES) {
    next[type] = { ...next[type], chat: false };
  }
  return next;
}
