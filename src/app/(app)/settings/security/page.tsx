"use client";

import { useCallback, useEffect, useState, FormEvent } from "react";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { LinkedIdentity, SignInMethods } from "@/components/settings/SignInMethods";
import { ProviderButtons } from "@/components/auth/ProviderButtons";

const LINK_RESULTS: Record<string, { tone: "success" | "error"; text: string }> = {
  linked: { tone: "success", text: "Linked. You can now sign in with it." },
  taken: { tone: "error", text: "That sign-in already belongs to another account here." },
  failed: { tone: "error", text: "Linking did not work. Try again." },
};

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
  const [methodsFailed, setMethodsFailed] = useState(false);
  const [linkPassword, setLinkPassword] = useState("");

  const readMethods = useCallback(() => {
    api
      .get("/api/users/me/identities")
      .then((loaded) => {
        setMethods(loaded);
        setMethodsFailed(false);
      })
      .catch(() => setMethodsFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    readMethods();
  }, [readMethods]);

  // Said once: the answer leaves the address before it is shown, so neither a second effect run
  // nor a reload repeats it
  useEffect(() => {
    const result = LINK_RESULTS[new URLSearchParams(window.location.search).get("link") ?? ""];
    if (!result) return;
    window.history.replaceState(null, "", "/settings/security");
    toast(result.text, result.tone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const providersSection = methods && (
    <>
      <SignInMethods identities={methods.identities} onChanged={readMethods} />
      <div className="mt-6">
        <ProviderButtons
          intent="link"
          verb="Link"
          divider={false}
          exclude={methods.identities.map((i) => i.provider)}
          extraBody={methods.hasPassword ? { currentPassword: linkPassword } : undefined}
          before={
            methods.hasPassword && (
              <Input
                id="linkPassword"
                type="password"
                autoComplete="current-password"
                aria-label="Current password, to link a provider"
                placeholder="Current password, to link a provider"
                value={linkPassword}
                onChange={(e) => setLinkPassword(e.target.value)}
              />
            )
          }
        />
      </div>
    </>
  );

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

  if (methodsFailed) {
    return (
      <p role="alert" className="text-sm text-danger">
        Could not load how this account signs in. Reload the page to try again.
      </p>
    );
  }
  if (!methods) return null;

  if (!methods.hasPassword) {
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
        {providersSection}
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
      {providersSection}
    </div>
  );
}
