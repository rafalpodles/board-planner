"use client";

import { useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { NotificationMatrixEditor } from "@/components/settings/NotificationMatrix";
import { NotificationMatrix } from "@/types";
import Link from "next/link";
import { SectionProps } from "./types";

interface Prefs {
  defaults: NotificationMatrix;
  projects: { project: string; matrix: NotificationMatrix }[];
  chat: { configured: boolean };
}

export function NotificationsSection({ project }: SectionProps) {
  const api = useApi();
  const { toast } = useToast();

  const [globalMatrix, setGlobalMatrix] = useState<NotificationMatrix | null>(null);
  const [matrix, setMatrix] = useState<NotificationMatrix | null>(null);
  const [overriding, setOverriding] = useState(false);
  const [chatConfigured, setChatConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  // The id, not the URL segment. Every link into a board is built from the project key
  // (`/projects/BP/settings`), and the stored override names an ObjectId — comparing the two
  // silently reported "following your global settings" over a live override nobody could clear.
  const id = String(project._id);

  useEffect(() => {
    api
      .get("/api/users/me/notifications")
      .then((prefs: Prefs) => {
        const own = prefs.projects.find((p) => p.project === id);
        setGlobalMatrix(prefs.defaults);
        setMatrix(own?.matrix ?? prefs.defaults);
        setOverriding(!!own);
        setChatConfigured(prefs.chat.configured);
      })
      .catch(() => setLoadFailed(true))
      .finally(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Switching on copies what is in force right now, rather than following the global grid
  // afterwards: a project somebody has tuned should not shift under them later. It is written
  // immediately, so the switch means the same thing after a reload as it did before one.
  async function toggleOverride(next: boolean) {
    const previous = matrix;
    setOverriding(next);
    if (next) {
      try {
        await api.put(`/api/users/me/notifications/${id}`, { matrix });
      } catch {
        setOverriding(false);
        toast("Failed to save", "error");
      }
      return;
    }
    setMatrix(globalMatrix);
    try {
      await api.del(`/api/users/me/notifications/${id}`);
      toast("Following your global settings again", "success");
    } catch {
      setOverriding(true);
      setMatrix(previous);
      toast("Failed to save", "error");
    }
  }

  async function save() {
    if (!matrix) return;
    setSaving(true);
    try {
      await api.put(`/api/users/me/notifications/${id}`, { matrix });
      toast("Saved for this project", "success");
    } catch {
      toast("Failed to save", "error");
    } finally {
      setSaving(false);
    }
  }

  if (loadFailed || (loaded && !matrix)) {
    return (
      <p className="max-w-2xl rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm">
        Your notification settings could not be loaded, so they cannot be changed from here right
        now. Reload the page to try again.
      </p>
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
    <div className="max-w-2xl">
      <div className="mb-5 flex items-center gap-3">
        <input
          type="checkbox"
          id="overrideNotifications"
          checked={overriding}
          onChange={(e) => toggleOverride(e.target.checked)}
          className="focus-ring rounded border-border"
        />
        <label htmlFor="overrideNotifications" className="text-sm cursor-pointer">
          Use my own settings for this project
        </label>
      </div>

      {!overriding && (
        <p className="mb-4 text-xs text-text-muted">
          Following your{" "}
          <Link href="/settings/notifications" className="underline">
            global notification settings
          </Link>
          .
        </p>
      )}

      <NotificationMatrixEditor
        value={matrix}
        onChange={setMatrix}
        disabled={!overriding}
        chatDisabled={!chatConfigured}
        chatDisabledHint="Connect Slack or Discord on your global Notifications page first."
      />

      {overriding && (
        <div className="mt-6">
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}
