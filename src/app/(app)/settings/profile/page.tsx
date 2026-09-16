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
  const [pendingEmail, setPendingEmail] = useState("");

  // Trimmed and lowercased the way the server normalises it, so the password prompt does not
  // appear for a stray capital that will not change anything
  const emailChanged = loadFailed ? false : email.trim().toLowerCase() !== savedEmail;
  // Trimmed the way the server normalises it, so trailing whitespace is not a change to refresh
  // the shell over
  const nameChanged = loadFailed ? false : fullName.trim() !== savedFullName;

  // A response can arrive after somebody has started typing — a slow connection, or simply a
  // second request in flight — and applying it then throws their edit away mid-sentence. The
  // baseline still moves, because it is what "changed" is measured against; only the field they
  // are holding is left alone.
  const edited = useRef(false);

  useEffect(() => {
    if (!user) return;
    // Fetch fresh user data
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
        // Without the stored address there is no way to tell a real change from a no-op, and the
        // old behaviour offered Save anyway — which the server refuses, asking for a password
        // there is no field for
        setLoadFailed(true);
        setLoaded(true);
      });
    api
      .get("/api/users/me/email-change")
      .then((data: { pending: { email: string } | null }) => setPendingEmail(data.pending?.email ?? ""))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function cancelPending() {
    try {
      await api.del("/api/users/me/email-change");
      setPendingEmail("");
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : "Could not cancel the change", "error");
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const saved: { email?: string; pendingEmail?: string } = await api.put("/api/users/me", {
        email,
        fullName,
        ...(emailChanged ? { currentPassword } : {}),
      });
      // A new address waits for its inbox to confirm it, so the field goes back to the one in force
      const inForce = saved.email ?? email.trim().toLowerCase();
      setSavedEmail(inForce);
      setEmail(inForce);
      if (saved.pendingEmail) setPendingEmail(saved.pendingEmail);
      else if (emailChanged) setPendingEmail("");
      setSavedFullName(fullName.trim());
      setFullName(fullName.trim());
      setCurrentPassword("");
      edited.current = false;
      // The shell renders the name from the cached user, so without this it keeps showing the old
      // one until a full reload — on the one screen where somebody is watching for it to change
      if (nameChanged) await refreshUser();
      toast(
        saved.pendingEmail
          ? `We sent a confirmation link to ${saved.pendingEmail}`
          : "Profile updated",
        "success"
      );
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
              password. The new address gets a link to confirm it, and the current one stays in
              use until then.
            </p>
          </div>
        )}

        {pendingEmail && (
          <div role="status" className="rounded-lg border border-border bg-surface-muted p-3 text-sm">
            <p>
              Waiting for <strong>{pendingEmail}</strong> to be confirmed. Open the link we sent there;
              until then, {savedEmail || "no address"} stays on your account.
            </p>
            <button type="button" onClick={() => void cancelPending()} className="mt-2 text-xs underline">
              Cancel this change
            </button>
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
            // Nothing to save is not something to offer: the route writes only what differs, so
            // this used to answer 200 having written nothing
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
