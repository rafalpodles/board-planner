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
  const [savedEmail, setSavedEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [emailNotifications, setEmailNotifications] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  // Trimmed and lowercased the way the server normalises it, so the password prompt does not
  // appear for a stray capital that will not change anything
  const emailChanged = loadFailed ? false : email.trim().toLowerCase() !== savedEmail;

  useEffect(() => {
    if (!user) return;
    // Fetch fresh user data
    api
      .get("/api/auth/me")
      .then((data: { email?: string; emailNotifications?: boolean }) => {
        setEmail(data.email || "");
        setSavedEmail(data.email || "");
        setEmailNotifications(data.emailNotifications || false);
        setLoaded(true);
      })
      .catch(() => {
        // Without the stored address there is no way to tell a real change from a no-op, and the
        // old behaviour offered Save anyway — which the server refuses, asking for a password
        // there is no field for
        setLoadFailed(true);
        setLoaded(true);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      await api.put("/api/users/me", {
        email,
        emailNotifications,
        ...(emailChanged ? { currentPassword } : {}),
      });
      setSavedEmail(email.trim().toLowerCase());
      setCurrentPassword("");
      toast("Profile updated", "success");
    } catch (err) {
      // The server's own words: "Current password is incorrect" is worth reading, where a generic
      // failure leaves somebody retyping a password that was right
      const message = err instanceof Error ? err.message : "";
      toast(message || "Failed to update profile", "error");
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
    <div className="w-full max-w-md mx-auto">
      <h2 className="text-lg font-semibold mb-6">Profile</h2>

      {loadFailed && (
        <p className="mb-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm">
          Your profile could not be loaded, so it cannot be saved from here right now. Reload the
          page to try again.
        </p>
      )}

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

        {emailChanged && (
          <div className="space-y-2 rounded-lg border border-border bg-surface-muted p-3">
            <Input
              label="Current password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
            <p className="text-xs text-text-muted">
              This address is where a password reset link is sent, so changing it needs your
              password. The old address will be told it is no longer the recovery address.
            </p>
          </div>
        )}

        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="emailNotifs"
            checked={emailNotifications}
            onChange={(e) => setEmailNotifications(e.target.checked)}
            className="focus-ring rounded border-border"
          />
          <label htmlFor="emailNotifs" className="text-sm cursor-pointer">
            Receive email notifications
          </label>
        </div>

        <p className="text-xs text-text-muted">
          When enabled, you&apos;ll receive emails for task assignments, mentions,
          and status changes on tasks you&apos;re watching.
        </p>

        <Button onClick={handleSave} disabled={saving || loadFailed || (emailChanged && !currentPassword.trim())}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
