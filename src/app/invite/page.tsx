"use client";

import { FormEvent, Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { APP_NAME } from "@/lib/brand";
import { ProviderButtons } from "@/components/auth/ProviderButtons";
import { usePasswordSignIn } from "@/hooks/use-password-sign-in";

const MIN_PASSWORD_LENGTH = 8;

interface Invitation {
  email: string;
  role: "admin" | "member";
  boards: { name: string; relation: "owner" | "member" }[];
  invitedBy: string | null;
}

type Lookup =
  | { state: "loading" }
  | { state: "open"; invitation: Invitation }
  | { state: "refused"; message: string }
  | { state: "failed"; message: string };

async function postJson(path: string, body: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

function AcceptForm() {
  const router = useRouter();
  const { user, isLoading, logout, refreshUser } = useAuth();
  const fromUrl = useSearchParams().get("token") ?? "";
  const [token] = useState(fromUrl);
  const [lookup, setLookup] = useState<Lookup>({ state: "loading" });

  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const passwordSignIn = usePasswordSignIn();

  useEffect(() => {
    if (fromUrl) window.history.replaceState(null, "", "/invite");
  }, [fromUrl]);

  const lookUp = useCallback(() => {
    setLookup({ state: "loading" });
    fetch("/api/invitations/lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (res.ok) setLookup({ state: "open", invitation: data as Invitation });
        else if (res.status === 400 && data.reason) setLookup({ state: "refused", message: data.error });
        else setLookup({ state: "failed", message: data.error || "Something went wrong." });
      })
      .catch(() => setLookup({ state: "failed", message: "Something went wrong." }));
  }, [token]);

  useEffect(() => {
    if (token) lookUp();
  }, [token, lookUp]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError("");
    if (password !== confirmPassword) {
      setError("The passwords do not match");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    setSaving(true);
    try {
      const { ok, data } = await postJson("/api/invitations/accept", {
        token,
        username,
        fullName,
        password,
      });
      if (!ok) {
        setError(data.error || "Something went wrong. Try again.");
        return;
      }
      setAccepted(true);
      await refreshUser();
      router.push(data.landing ? `/projects/${data.landing}` : "/projects");
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
        <p className="text-sm text-text-muted">
          Open the link from the invitation exactly as it arrived, or ask for a new one.
        </p>
      </div>
    );
  }

  if (!accepted && !isLoading && user) {
    return (
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-bold mb-2">You are already signed in</h1>
        <p className="text-sm text-text-muted mb-6">
          You are signed in as {user.username}. Sign out to accept this invitation with a new account.
        </p>
        <Button onClick={() => logout()} className="w-full">
          Sign out
        </Button>
      </div>
    );
  }

  if (lookup.state === "loading") return null;

  if (lookup.state === "refused") {
    return (
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-bold mb-2">This invitation cannot be used</h1>
        <p role="alert" className="text-sm text-text-muted mb-6">
          {lookup.message}
        </p>
        <Link href="/login" className="text-sm underline">
          Go to sign in
        </Link>
      </div>
    );
  }

  if (lookup.state === "failed") {
    return (
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-bold mb-2">The invitation could not be loaded</h1>
        <p role="alert" className="text-sm text-text-muted mb-6">
          {lookup.message}
        </p>
        <Button onClick={lookUp} className="w-full">
          Try again
        </Button>
      </div>
    );
  }

  const { invitation } = lookup;

  return (
    <div className="w-full max-w-sm">
      <h1 className="text-2xl font-bold text-center mb-2">Join {APP_NAME}</h1>
      <p className="text-sm text-text-muted text-center mb-6">
        {invitation.invitedBy ?? "An administrator"} invited {invitation.email}
        {invitation.role === "admin" ? " as an administrator" : ""}.
      </p>
      {invitation.boards.length > 0 && (
        <ul className="mb-6 rounded-lg border border-border divide-y divide-border text-sm">
          {invitation.boards.map((b, i) => (
            <li key={i} className="flex justify-between gap-3 px-3 py-2">
              <span className="truncate">{b.name}</span>
              <span className="text-text-muted shrink-0">
                {b.relation === "owner" ? "Owner" : "Member"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {passwordSignIn && (
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
        <Input
          label="Password"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Input
          label="Confirm password"
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
        <Button type="submit" className="w-full" disabled={saving || accepted}>
          {saving || accepted ? "Creating your account…" : "Create my account"}
        </Button>
      </form>
      )}
      {passwordSignIn !== null && (
        <div className={passwordSignIn ? "mt-4" : undefined}>
          <ProviderButtons intent="invite" invitationToken={token} verb="Accept with" divider={passwordSignIn} />
        </div>
      )}
    </div>
  );
}

export default function InvitePage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <Suspense fallback={null}>
        <AcceptForm />
      </Suspense>
    </div>
  );
}
