"use client";

import { useState, useEffect, useRef } from "react";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { FULL_NAME_MAX_LENGTH } from "@/lib/identifiers";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import Link from "next/link";

export default function ProfilePage() {
  const api = useApi();
  const { user, refreshUser } = useAuth();
  const { toast } = useToast();

  const [email, setEmail] = useState("");
  const [savedEmail, setSavedEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [savedFullName, setSavedFullName] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const emailChanged = loadFailed ? false : email.trim().toLowerCase() !== savedEmail;
  const nameChanged = loadFailed ? false : fullName.trim() !== savedFullName;

  const edited = useRef(false);

  useEffect(() => {
    if (!user) return;
    api
      .get("/api/auth/me")
      .then((data: { email?: string; fullName?: string }) => {
        setSavedEmail(data.email || "");
        setSavedFullName(data.fullName || "");
        if (!edited.current) {
          setEmail(data.email || "");
          setFullName(data.fullName || "");
        }
        setLoaded(true);
      })
      .catch(() => {
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
        fullName,
        ...(emailChanged ? { currentPassword } : {}),
      });
      setSavedEmail(email.trim().toLowerCase());
      setSavedFullName(fullName.trim());
      setFullName(fullName.trim());
      setCurrentPassword("");
      edited.current = false;
      if (nameChanged) await refreshUser();
      toast("Profile updated", "success");
    } catch (err) {
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
          <label className="block text-sm font-medium text-text-muted mb-1">Username</label>
          <p className="text-sm text-text-muted">{user?.username}</p>
        </div>

        <Input
          label="Full Name"
          value={fullName}
          onChange={(e) => {
            edited.current = true;
            setFullName(e.target.value);
          }}
          maxLength={FULL_NAME_MAX_LENGTH}
          placeholder="How you appear on tasks and comments"
        />

        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(e) => {
            edited.current = true;
            setEmail(e.target.value);
          }}
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

        <p className="text-xs text-text-muted">
          Which events reach you, and through which channel, is now a grid on the{" "}
          <Link href="/settings/notifications" className="underline">
            Notifications
          </Link>{" "}
          page — one switch for e-mail could not say &quot;mentions yes, status changes no&quot;.
        </p>

        <Button
          onClick={handleSave}
          disabled={
            saving ||
            loadFailed ||
            !fullName.trim() ||
            (!nameChanged && !emailChanged) ||
            (emailChanged && !currentPassword.trim())
          }
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
