import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { User } from "@/models/user";
import {
  defaultMatrix,
  normaliseMatrix,
  wantsChat,
  withoutChat,
} from "@/lib/notification-prefs";
import { NotificationMatrix, PERSONAL_CHAT_KINDS, PersonalChatKind } from "@/types";
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
  kind: PersonalChatKind | "";
  /** Whether an address will be stored. Delivery needs this AND a kind; either alone sends nothing. */
  hasUrl: boolean;
  /** Field writes this outcome implies. Empty when the request said nothing about the connection. */
  writes: Record<string, string>;
}

type Refusal = { error: string; status: number };

/**
 * The connection is decided once, from the stored state and the request, and every branch returns a
 * complete outcome rather than updating flags on the way past. Three defects came from the previous
 * shape — a request that changed nothing reported the connection gone and wiped the chat column
 * everywhere, an address could be stored under no service, and a `chat` that was not an object
 * deleted the credential — and all three were a tracked flag disagreeing with what was written.
 */
function resolveChat(
  body: unknown,
  storedChat: { kind?: string; webhookUrl?: string } | undefined
): ChatOutcome | Refusal {
  const current: ChatOutcome = {
    kind: (storedChat?.kind ?? "") as PersonalChatKind | "",
    hasUrl: !!storedChat?.webhookUrl,
    writes: {},
  };

  const chat = (body as { chat?: unknown })?.chat;
  // Absent says nothing about the connection. So does a value that is not an object: it is a
  // malformed request, and reading it as "disconnect me" once deleted a stored credential on a 200.
  if (chat === undefined || chat === null) return current;
  const isObject = chat !== null && typeof chat === "object" && !Array.isArray(chat);
  if (!isObject) {
    return { error: "chat must be an object", status: 400 };
  }

  const { kind: rawKind, webhookUrl: rawUrl } = chat as { kind?: unknown; webhookUrl?: unknown };
  const named = typeof rawKind === "string" ? rawKind : "";
  if (named && !PERSONAL_CHAT_KINDS.includes(named as PersonalChatKind)) {
    return { error: "Unknown chat service", status: 400 };
  }
  const kind = named as PersonalChatKind | "";

  const raw = typeof rawUrl === "string" ? rawUrl.trim() : "";
  const keeping = raw === WEBHOOK_KEPT;
  const url = keeping ? "" : raw;

  // An address with no service is as useless as a service with no address, and storing one left a
  // credential nothing would ever read
  if (!kind && url) {
    return { error: "Choose Slack or Discord for that address", status: 400 };
  }

  if (!kind) {
    // Clearing the service clears the credential with it
    return { kind: "", hasUrl: false, writes: { kind: "", webhookUrl: "" } };
  }

  const sameService = kind === storedChat?.kind;
  if (!url) {
    // Naming a service with no new address is only meaningful if that service already has one.
    // Switching service while keeping the old address posts one service's payload shape at the
    // other's endpoint forever, with the screen still reporting a healthy connection.
    if (!sameService) {
      return { error: "That service needs its own webhook address", status: 400 };
    }
    // Re-stating the connection exactly as it stands. Writing `kind` again is harmless; claiming
    // the address went away is not, and that claim is what wiped the chat column everywhere.
    return { kind, hasUrl: current.hasUrl, writes: { kind } };
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
  return { kind, hasUrl: true, writes: { kind, webhookUrl: encryptSecret(url) } };
}

function isRefusal(outcome: ChatOutcome | Refusal): outcome is Refusal {
  return "error" in outcome;
}

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
  const chat = resolveChat(body, stored?.notifications?.chat);
  if (isRefusal(chat)) {
    return NextResponse.json({ error: chat.error }, { status: chat.status });
  }

  const connected = !!chat.kind && chat.hasUrl;
  const grid = (updates["notifications.defaults"] ?? defaultMatrix(stored)) as NotificationMatrix;
  const overrides = stored?.notifications?.projects ?? [];

  // The gate is on the outcome, not on the shape of the request. Scoped to `body.chat` it stopped a
  // token choosing the address while leaving it free to switch the channel on against an address
  // the owner had already stored — the standing outbound copy the rule exists to prevent, reached
  // without ever mentioning chat. Two things are withheld: installing an address, and widening
  // where chat may deliver. Tearing the channel down stays open, and so does every other edit.
  const installsAddress = !!chat.writes.webhookUrl;
  const widensChat = connected && wantsChat(grid) && !wantsChat(defaultMatrix(stored));
  if (user.viaMachineCredential && (installsAddress || widensChat)) {
    return NextResponse.json(
      { error: "This action requires an interactive session" },
      { status: 403 }
    );
  }

  for (const [field, value] of Object.entries(chat.writes)) {
    updates[`notifications.chat.${field}`] = value;
  }

  if (!connected) {
    // Disconnecting is allowed — it just cannot leave a column ticked that now delivers nowhere,
    // in the grid being written OR in one already stored, including every project override. Those
    // are cleared rather than refused, because refusing left people unable to save at all.
    if (wantsChat(grid)) {
      updates["notifications.defaults"] = withoutChat(grid);
    }
    // Row by row rather than rewriting the array: a wholesale $set regenerates every subdocument
    // id and silently reverts a row another tab added between the read and the write.
    overrides.forEach((p, index) => {
      if (wantsChat(p.matrix)) {
        updates[`notifications.projects.${index}.matrix`] = withoutChat(p.matrix);
      }
    });
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  await User.findByIdAndUpdate(user._id, { $set: updates });

  return NextResponse.json({ ok: true, chatConnected: connected });
});
