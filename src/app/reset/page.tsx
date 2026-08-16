"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

const MIN_PASSWORD_LENGTH = 8;

function ResetForm() {
  const router = useRouter();
  const fromUrl = useSearchParams().get("token") ?? "";
  const [token] = useState(fromUrl);

  // Off the address bar as soon as it is held: same-origin requests send the full URL in Referer
  // under this app's referrer policy, so the token would reach the proxy's access log, and it
  // would sit in browser history and on screen during a screen share.
  useEffect(() => {
    if (fromUrl) window.history.replaceState(null, "", "/reset");
  }, [fromUrl]);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (newPassword !== confirmPassword) {
      setError("The passwords do not match");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/auth/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Something went wrong. Try again.");
        return;
      }
      setDone(true);
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!token) {
    return (
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-bold mb-2">This link is incomplete</h1>
        <p className="text-sm text-text-muted mb-6">
          Open the link from the email exactly as it arrived, or ask for a new one.
        </p>
        <Link href="/forgot" className="text-sm underline">
          Ask for a new link
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div role="status" className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-bold mb-2">Your password is set</h1>
        {/* "Every other session" would be wrong here — nobody is signed in on this screen, and
            whoever knew the old password has just been signed out too, which is usually the point */}
        {/* "Signed out on every device" and not "everywhere": API tokens are a separate credential
            and survive this, which the documentation says plainly rather than this screen */}
        <p className="text-sm text-text-muted mb-6">
          You have been signed out on every device. Sign in with your new password.
        </p>
        <Button onClick={() => router.push("/login")} className="w-full">
          Sign In
        </Button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <h1 className="text-2xl font-bold text-center mb-6">Choose a new password</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          autoFocus
          minLength={MIN_PASSWORD_LENGTH}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
        />
        <Input
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
        />

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={saving || !newPassword}>
          {saving ? "Setting…" : "Set the password"}
        </Button>
      </form>
      <p className="mt-6 text-sm text-text-muted text-center">
        <Link href="/forgot" className="underline">
          Ask for a new link
        </Link>
      </p>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <Suspense fallback={null}>
        <ResetForm />
      </Suspense>
    </div>
  );
}
