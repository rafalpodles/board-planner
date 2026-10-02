"use client";

import { useCallback, useEffect, useState, FormEvent } from "react";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { LinkedIdentity, SignInMethods } from "@/components/settings/SignInMethods";

const MIN_PASSWORD_LENGTH = 8;

export default function SecurityPage() {
  const api = useApi();
  const { toast } = useToast();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [methods, setMethods] = useState<{ hasPassword: boolean; identities: LinkedIdentity[] } | null>(
    null
  );

  const readMethods = useCallback(() => {
    api
      .get("/api/users/me/identities")
      .then(setMethods)
      .catch(() => setMethods({ hasPassword: true, identities: [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    readMethods();
  }, [readMethods]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError("The new passwords do not match");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }

    setSaving(true);
    try {
      await api.put("/api/users/me/password", { currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast("Password changed", "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setSaving(false);
    }
  }

  if (methods && !methods.hasPassword) {
    return (
      <div className="max-w-md">
        <h2 className="text-lg font-semibold mb-1">Password</h2>
        <p className="text-sm text-text-muted">
          This account has no password. To add one, use{" "}
          <Link href="/forgot" className="underline">
            Forgot your password
          </Link>{" "}
          — the link goes to your address.
        </p>
        <SignInMethods identities={methods.identities} onChanged={readMethods} />
      </div>
    );
  }

  return (
    <div className="max-w-md">
      <h2 className="text-lg font-semibold mb-1">Change password</h2>
      <p className="text-sm text-text-muted mb-6">
        You stay signed in on this device. Every other device, API token, connected app such as
        Claude Code, and machine you enrolled is signed out and has to be set up again.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="currentPassword" className="block text-sm font-medium mb-1">
            Current password
          </label>
          <Input
            id="currentPassword"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
        </div>

        <div>
          <label htmlFor="newPassword" className="block text-sm font-medium mb-1">
            New password
          </label>
          <Input
            id="newPassword"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={MIN_PASSWORD_LENGTH}
          />
          <p className="mt-1 text-xs text-text-muted">
            At least {MIN_PASSWORD_LENGTH} characters.
          </p>
        </div>

        <div>
          <label htmlFor="confirmPassword" className="block text-sm font-medium mb-1">
            Confirm new password
          </label>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <Button type="submit" disabled={saving || !currentPassword || !newPassword}>
          {saving ? "Changing…" : "Change password"}
        </Button>
      </form>
      {methods && <SignInMethods identities={methods.identities} onChanged={readMethods} />}
    </div>
  );
}
