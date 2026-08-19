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

export function NotificationsSection({ projectId }: SectionProps) {
  const api = useApi();
  const { toast } = useToast();

  const [globalMatrix, setGlobalMatrix] = useState<NotificationMatrix | null>(null);
  const [matrix, setMatrix] = useState<NotificationMatrix | null>(null);
  const [overriding, setOverriding] = useState(false);
  const [chatConfigured, setChatConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api
      .get("/api/users/me/notifications")
      .then((prefs: Prefs) => {
        const own = prefs.projects.find((p) => p.project === projectId);
        setGlobalMatrix(prefs.defaults);
        setMatrix(own?.matrix ?? prefs.defaults);
        setOverriding(!!own);
        setChatConfigured(prefs.chat.configured);
      })
      .finally(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Switching on copies what is in force right now, rather than following the global grid
  // afterwards: a project somebody has tuned should not shift under them later.
  async function toggleOverride(next: boolean) {
    setOverriding(next);
    if (!next) {
      setMatrix(globalMatrix);
      try {
        await api.del(`/api/users/me/notifications/${projectId}`);
        toast("Following your global settings again", "success");
      } catch {
        setOverriding(true);
        toast("Failed to save", "error");
      }
    }
  }

  async function save() {
    if (!matrix) return;
    setSaving(true);
    try {
      await api.put(`/api/users/me/notifications/${projectId}`, { matrix });
      toast("Saved for this project", "success");
    } catch {
      toast("Failed to save", "error");
    } finally {
      setSaving(false);
    }
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
