"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { APP_NAME } from "@/lib/brand";

const REFUSALS: Record<string, string> = {
  invitation: "This invitation can no longer be used. Ask whoever invited you for a new one.",
  unverified: "Your provider has not confirmed your address, so it cannot accept this invitation.",
  mismatch: "Your provider signed you in with a different address from the one invited. Sign in to the provider with the invited address, or open the invitation link again and choose a password.",
  linked: "That sign-in already belongs to an account here. Sign in with it instead.",
};

interface Held {
  email: string;
  role: "admin" | "member";
  boards: { name: string; relation: "owner" | "member" }[];
  invitedBy: string | null;
  provider: string;
}

function SsoAcceptance() {
  const router = useRouter();
  const { refreshUser } = useAuth();
  const refusedFor = useSearchParams().get("error");
  const [held, setHeld] = useState<Held | null>(null);
  const [failure, setFailure] = useState(refusedFor ? (REFUSALS[refusedFor] ?? REFUSALS.invitation) : "");
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (refusedFor) return;
    fetch("/api/invitations/sso")
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (res.ok) setHeld(data as Held);
        else setFailure(data.error || "Something went wrong. Open the invitation link again.");
      })
      .catch(() => setFailure("Something went wrong. Open the invitation link again."));
  }, [refusedFor]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/invitations/sso", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, fullName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Something went wrong. Try again.");
        setSaving(false);
        return;
      }
      await refreshUser();
      router.push(data.landing ? `/projects/${data.landing}` : "/projects");
    } catch {
      setError("Something went wrong. Try again.");
      setSaving(false);
    }
  }

  if (failure) {
    return (
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-bold mb-2">This invitation cannot be accepted this way</h1>
        <p role="alert" className="text-sm text-text-muted mb-6">
          {failure}
        </p>
        <Link href="/login" className="text-sm underline">
          Go to sign in
        </Link>
      </div>
    );
  }
  if (!held) return null;

  return (
    <div className="w-full max-w-sm">
      <h1 className="text-2xl font-bold text-center mb-2">Join {APP_NAME}</h1>
      <p className="text-sm text-text-muted text-center mb-6">
        {held.provider} confirmed {held.email}. Choose your username to finish.
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Username"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <Input
          label="Full name"
          autoComplete="name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          required
        />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={saving}>
          {saving ? "Creating your account…" : "Create my account"}
        </Button>
      </form>
    </div>
  );
}

export default function SsoAcceptancePage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <Suspense fallback={null}>
        <SsoAcceptance />
      </Suspense>
    </div>
  );
}
