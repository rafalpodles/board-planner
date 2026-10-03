"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { APP_NAME } from "@/lib/brand";

interface Held {
  email: string;
  name: string;
  provider: string;
}

function SsoSignUp() {
  const router = useRouter();
  const { refreshUser } = useAuth();
  const [held, setHeld] = useState<Held | null>(null);
  const [failure, setFailure] = useState("");
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/auth/oidc/signup")
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setFailure(data.error || "Something went wrong. Sign in again.");
          return;
        }
        setHeld(data as Held);
        setFullName((data as Held).name);
      })
      .catch(() => setFailure("Something went wrong. Sign in again."));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/auth/oidc/signup", {
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
      router.push("/projects");
    } catch {
      setError("Something went wrong. Try again.");
      setSaving(false);
    }
  }

  if (failure) {
    return (
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-bold mb-2">This sign-up cannot be finished</h1>
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
        {held.provider} confirmed {held.email}. Choose your username to finish. You will see boards once somebody adds
        you to one.
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

export default function SsoSignUpPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <Suspense fallback={null}>
        <SsoSignUp />
      </Suspense>
    </div>
  );
}
