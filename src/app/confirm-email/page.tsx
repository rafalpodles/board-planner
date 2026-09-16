"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";

function tokenFromFragment(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
}

export default function ConfirmEmailPage() {
  const [token, setToken] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState("");
  const held = useRef<string | null>(null);

  // In the fragment, so it never reaches a server log or a Referer; off the address bar once held
  // Read once: an effect that runs twice would find the address bar already cleared
  useEffect(() => {
    if (held.current === null) held.current = tokenFromFragment();
    setToken(held.current);
    if (held.current) window.history.replaceState(null, "", "/confirm-email");
  }, []);

  async function confirm() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/auth/confirm-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Something went wrong. Try again.");
        return;
      }
      setConfirmed(data.email);
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setSaving(false);
    }
  }

  let content;
  if (token === null) {
    content = null;
  } else if (!token) {
    content = (
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-bold mb-2">This link is incomplete</h1>
        <p className="text-sm text-text-muted mb-6">
          Open the link from the email exactly as it arrived, or change the address again from your profile.
        </p>
      </div>
    );
  } else if (confirmed) {
    content = (
      <div role="status" className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-bold mb-2">Address confirmed</h1>
        <p className="text-sm text-text-muted mb-6">
          {confirmed} is now the address on your account. Password reset links go there from now on.
        </p>
        <Link href="/login" className="text-sm underline">
          Sign in
        </Link>
      </div>
    );
  } else {
    content = (
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-bold mb-2">Confirm this email address</h1>
        <p className="text-sm text-text-muted mb-6">
          It replaces the address on your account and receives password reset links from now on.
        </p>
        {error && (
          <p role="alert" className="text-sm text-danger mb-4">
            {error}
          </p>
        )}
        <Button onClick={() => void confirm()} className="w-full" disabled={saving}>
          {saving ? "Confirming…" : "Confirm this address"}
        </Button>
      </div>
    );
  }

  return <div className="min-h-screen flex items-center justify-center px-4">{content}</div>;
}
