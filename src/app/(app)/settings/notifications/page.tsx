"use client";

import { useState, useEffect } from "react";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { NotificationMatrixEditor } from "@/components/settings/NotificationMatrix";
import { NotificationMatrix, PERSONAL_CHAT_KINDS, PersonalChatKind } from "@/types";


function messageOf(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message.trim() : "";
  return message || fallback;
}

interface Loaded {
  defaults: NotificationMatrix;
  chat: { kind: PersonalChatKind | ""; configured: boolean };
}

export default function NotificationsPage() {
  const api = useApi();
  const { user, refreshUser } = useAuth();
  const { toast } = useToast();

  const [matrix, setMatrix] = useState<NotificationMatrix | null>(null);
  const [chatKind, setChatKind] = useState<PersonalChatKind | "">("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [chatConfigured, setChatConfigured] = useState(false);
  const [emailDigest, setEmailDigest] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  // Delivery needs both a service and an address; either alone sends nothing and says nothing
  const chatReady = !!chatKind && (chatConfigured || !!webhookUrl.trim());

  useEffect(() => {
    if (!user) return;
    Promise.all([
      api.get("/api/users/me/notifications"),
      api.get("/api/auth/me"),
    ])
      .then(([prefs, me]: [Loaded, { emailDigest?: boolean }]) => {
        setMatrix(prefs.defaults);
        setChatKind(prefs.chat.kind);
        setChatConfigured(prefs.chat.configured);
        setEmailDigest(me.emailDigest ?? false);
      })
      .catch(() => setLoadFailed(true))
      .finally(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    if (!matrix) return;
    setSaving(true);
    try {
      await api.put("/api/users/me/notifications", {
        defaults: matrix,
        chat: {
          kind: chatKind,
          // A blank field on a screen that already has a webhook means "leave it alone", not
          // "delete it" — the stored value never comes back here to be resent
          webhookUrl: webhookUrl.trim() || (chatConfigured ? "__kept__" : ""),
        },
      });
      setWebhookUrl("");
      setChatConfigured(chatConfigured || !!webhookUrl.trim());
      toast("Notification settings saved", "success");
    } catch (err) {
      // The server's refusals name what to do — "connect Slack or Discord first", "that service
      // needs its own webhook address". Swallowing them left every one reading as a shrug.
      toast(messageOf(err, "Failed to save notification settings"), "error");
    } finally {
      setSaving(false);
    }
  }

  async function toggleDigest(next: boolean) {
    const previous = emailDigest;
    setEmailDigest(next);
    try {
      await api.put("/api/users/me", { emailDigest: next });
      await refreshUser();
    } catch (err) {
      setEmailDigest(previous);
      toast(messageOf(err, "Failed to save preference"), "error");
    }
  }

  if (loadFailed || (loaded && !matrix)) {
    return (
      <div className="w-full max-w-2xl mx-auto">
        <h2 className="text-lg font-semibold mb-6">Notifications</h2>
        <p className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm">
          Your notification settings could not be loaded, so they cannot be saved from here right
          now. Reload the page to try again.
        </p>
      </div>
    );
  }

  if (!loaded || !matrix) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="w-full max-w-2xl mx-auto">
      <h2 className="text-lg font-semibold mb-1">Notifications</h2>
      <p className="mb-6 text-sm text-text-muted">
        These apply in every project, unless a project&apos;s own Notifications page says otherwise.
      </p>

      <NotificationMatrixEditor
        value={matrix}
        onChange={setMatrix}
        chatDisabled={!chatReady}
        chatDisabledHint="Connect Slack or Discord below before sending anything there."
      />

      <div className="mt-6 flex items-center gap-3">
        <input
          type="checkbox"
          id="emailDigest"
          checked={emailDigest}
          onChange={(e) => toggleDigest(e.target.checked)}
          className="focus-ring rounded border-border"
        />
        <label htmlFor="emailDigest" className="text-sm cursor-pointer">
          Collect the e-mail column into one daily digest
        </label>
      </div>
      <p className="mt-2 text-xs text-text-muted">
        One message each morning listing what you have not read yet, instead of a mail per event.
        Password and account-security notices are never held back.
      </p>

      <h3 className="mt-10 mb-1 text-sm font-semibold">Your chat connection</h3>
      <p className="mb-4 text-xs text-text-muted">
        A webhook of your own, for the messages addressed to you. A project can also post to a
        shared team channel — that is set up in the project&apos;s Integrations page and is not
        affected by anything here.
      </p>

      <div className="space-y-3">
        <div className="flex gap-2">
          {PERSONAL_CHAT_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => {
                const next = chatKind === kind ? "" : kind;
                setChatKind(next);
                // The ticks stay: with nothing connected they simply do not deliver, and they
                // start working again if a webhook comes back. Clearing the address field matters
                // though — it is about to be hidden, and sending one for no service is refused.
                if (!next) setWebhookUrl("");
              }}
              className={`focus-ring rounded-lg border px-3 py-1.5 text-sm capitalize transition-colors ${
                chatKind === kind
                  ? "border-primary bg-primary/10"
                  : "border-border hover:border-primary"
              }`}
            >
              {kind}
            </button>
          ))}
        </div>

        {chatKind && (
          <input
            type="url"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder={
              chatConfigured
                ? "A webhook is stored — type a new one to replace it"
                : chatKind === "slack"
                  ? "https://hooks.slack.com/services/..."
                  : "https://discord.com/api/webhooks/..."
            }
            className="focus-ring w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm"
          />
        )}
      </div>

      <div className="mt-8">
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
