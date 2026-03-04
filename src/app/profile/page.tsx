"use client";

import { useState, useEffect } from "react";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";

export default function ProfilePage() {
  const api = useApi();
  const { user } = useAuth();
  const { toast } = useToast();

  const [email, setEmail] = useState("");
  const [emailNotifications, setEmailNotifications] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!user) return;
    // Fetch fresh user data
    api
      .get("/api/auth/me")
      .then((data: { email?: string; emailNotifications?: boolean }) => {
        setEmail(data.email || "");
        setEmailNotifications(data.emailNotifications || false);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      await api.put("/api/users/me", { email, emailNotifications });
      toast("Profile updated", "success");
    } catch {
      toast("Failed to update profile", "error");
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto">
      <h1 className="text-2xl font-bold mb-6">Profile Settings</h1>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Username</label>
          <p className="text-sm text-text-muted">{user?.username}</p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Full Name</label>
          <p className="text-sm text-text-muted">{user?.fullName}</p>
        </div>

        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
        />

        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="emailNotifs"
            checked={emailNotifications}
            onChange={(e) => setEmailNotifications(e.target.checked)}
            className="rounded border-border"
          />
          <label htmlFor="emailNotifs" className="text-sm cursor-pointer">
            Receive email notifications
          </label>
        </div>

        <p className="text-xs text-text-muted">
          When enabled, you&apos;ll receive emails for task assignments, mentions,
          and status changes on tasks you&apos;re watching.
        </p>

        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
