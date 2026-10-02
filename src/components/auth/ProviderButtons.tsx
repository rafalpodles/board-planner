"use client";

import { ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";

interface Provider {
  id: string;
  label: string;
}

/**
 * One button per identity provider the operator configured, and nothing at all when there are
 * none — an instance with passwords only shows no trace of this.
 */
export function ProviderButtons({
  intent,
  invitationToken,
  verb = "Continue with",
  exclude = [],
  divider = true,
  extraBody,
  before,
}: {
  intent: "signin" | "invite" | "link";
  invitationToken?: string;
  verb?: string;
  exclude?: string[];
  divider?: boolean;
  extraBody?: Record<string, string>;
  /** Shown above the buttons, and only when there is a button to show. */
  before?: ReactNode;
}) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [going, setGoing] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    fetch("/api/auth/oidc/providers")
      .then((res) => (res.ok ? res.json() : []))
      .then((list: Provider[]) => live && setProviders(Array.isArray(list) ? list : []))
      .catch(() => live && setProviders([]));
    return () => {
      live = false;
    };
  }, []);

  async function start(provider: Provider) {
    if (going) return;
    setGoing(provider.id);
    setError("");
    try {
      const res = await fetch(`/api/auth/oidc/${provider.id}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent, invitationToken, ...extraBody }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.url !== "string") {
        setError(data.error || "Something went wrong. Try again.");
        setGoing(null);
        return;
      }
      window.location.assign(data.url);
    } catch {
      setError("Something went wrong. Try again.");
      setGoing(null);
    }
  }

  const offered = providers.filter((p) => !exclude.includes(p.id));
  if (offered.length === 0) return null;

  return (
    <div className="space-y-3">
      {before}
      {divider && (
        <div className="flex items-center gap-3 text-xs text-text-muted" aria-hidden="true">
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>
      )}
      {offered.map((provider) => (
        <Button
          key={provider.id}
          type="button"
          variant="secondary"
          className="w-full"
          disabled={!!going}
          onClick={() => start(provider)}
        >
          {going === provider.id ? "Redirecting…" : `${verb} ${provider.label}`}
        </Button>
      ))}
      {error && (
        <p role="alert" className="text-sm text-danger text-center">
          {error}
        </p>
      )}
    </div>
  );
}

export const SIGN_IN_REFUSALS: Record<string, string> = {
  failed: "Signing in with that provider did not work. Try again.",
  no_account: "No account here uses that address. Ask an administrator for an invitation.",
  unverified: "That provider has not confirmed your address, so it cannot sign you in here.",
  unproven:
    "Your address here has not been confirmed, so a provider cannot sign you in by it. Sign in with your password and link the provider under Settings → Security.",
  not_linked:
    "That account is not linked here yet. Sign in with your password and link it under Settings → Security, or ask for an invitation.",
  throttled: "Too many attempts. Try again in 15 minutes.",
};
