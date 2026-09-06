"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { APP_NAME } from "@/lib/brand";

export default function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSending(true);
    try {
      const res = await fetch("/api/auth/forgot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Something went wrong. Try again.");
        return;
      }
      setSent(true);
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-center mb-2">
          {sent ? "Check your email" : "Forgot your password?"}
        </h1>

        {sent ? (
          <div role="status">
            <p className="text-sm text-text-muted text-center mb-6">
              If that account exists and has an email address, a link is on its way. The link works
              once and expires in an hour.
            </p>
            <p className="text-sm text-text-muted text-center mb-6">
              Nothing arrived? Ask an administrator to set a password for you.
            </p>
            <p className="text-sm text-text-muted text-center">
              <Link href="/login" className="underline">
                Back to sign in
              </Link>
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-text-muted text-center mb-6">
              {APP_NAME} will email you a link to set a new password.
            </p>
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                label="Username or email"
                autoComplete="username"
                autoFocus
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
              />

              {error && (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              )}

              <Button type="submit" className="w-full" disabled={sending || !identifier.trim()}>
                {sending ? "Sending…" : "Send the link"}
              </Button>
            </form>
            <p className="mt-6 text-sm text-text-muted text-center">
              <Link href="/login" className="underline">
                Back to sign in
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
