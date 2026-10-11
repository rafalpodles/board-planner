"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useId, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { SettingsCard } from "@/components/settings/SettingsCard";

interface SsoAnswer {
  hosted: boolean;
  plan?: "free" | "pro";
  trial?: boolean;
  trialEndsAt?: string | null;
  available?: boolean;
  set?: boolean;
  issuer?: string;
  clientId?: string;
  label?: string;
  secretHint?: string;
  unreadable?: boolean;
  active?: boolean;
  redirectUri?: string | null;
}

const TITLE = "Your identity provider";
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function Form({ state, onSaved }: { state: SsoAnswer; onSaved: (answer: SsoAnswer) => void }) {
  const api = useApi();
  const { toast } = useToast();
  const errorId = useId();
  const [label, setLabel] = useState(state.label ?? "Single sign-on");
  const [issuer, setIssuer] = useState(state.issuer ?? "");
  const [clientId, setClientId] = useState(state.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);

  // The stored secret belongs to the issuer and client it was given for; the server asks again when either changes
  const needsSecret = !state.set || issuer.trim() !== state.issuer || clientId.trim() !== state.clientId;

  async function send(work: () => Promise<SsoAnswer>, done: string) {
    setBusy(true);
    setError("");
    try {
      const answer = await work();
      setClientSecret("");
      setConfirmingRemoval(false);
      onSaved(answer);
      toast(done, "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
      setConfirmingRemoval(false);
    } finally {
      setBusy(false);
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault();
    return send(() => api.put("/api/settings/sso", { issuer: issuer.trim(), clientId: clientId.trim(), clientSecret, label: label.trim() }), "Sign-in provider saved");
  };

  return (
    <>
      <form onSubmit={save} className="space-y-3" data-testid="sso-form">
        <Input label="Button name" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="Acme login" />
        <Input
          label="Issuer"
          value={issuer}
          onChange={(e) => setIssuer(e.target.value)}
          placeholder="https://login.example.com"
          spellCheck={false}
          autoComplete="off"
          required
        />
        <Input label="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} autoComplete="off" required />
        <Input
          label="Client secret"
          type="password"
          // Not "off", which a password field ignores: this must not be filled with the admin's own login
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          spellCheck={false}
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder={state.set && !needsSecret ? `Stored, ending in ${state.secretHint}. Leave blank to keep it` : ""}
          required={needsSecret}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        {error && (
          <p id={errorId} role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !issuer.trim() || !clientId.trim() || (needsSecret && !clientSecret)}>
            {busy ? "Checking…" : state.set ? "Save changes" : "Save provider"}
          </Button>
          {state.set && (
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setConfirmingRemoval(true)}>
              Remove
            </Button>
          )}
        </div>
      </form>
      <ConfirmDialog
        open={confirmingRemoval}
        onClose={() => setConfirmingRemoval(false)}
        onConfirm={() => send(() => api.del("/api/settings/sso"), "Sign-in provider removed")}
        title="Remove your identity provider?"
        message="Signing in with it stops at once. People who only ever signed in through it can sign in with an e-mailed code and the Forgot password link, which sets a password. You will need the client secret to add it again."
        confirmLabel="Remove"
        loadingLabel="Removing…"
        loading={busy}
      />
    </>
  );
}

function Card({ state, onSaved }: { state: SsoAnswer; onSaved: (answer: SsoAnswer) => void }) {
  const available = state.available === true;
  const status = state.unreadable
    ? { label: "Cannot be read", on: false }
    : state.active
      ? { label: "Signing in", on: true }
      : state.set
        ? { label: "Saved, not offered", on: false }
        : { label: "Not set up", on: false };

  return (
    <SettingsCard
      title={TITLE}
      description="Your people sign in with your own OpenID Connect provider (Okta, Microsoft Entra ID, Keycloak). Google and GitHub sign-in stay as they are."
      status={status}
    >
      {state.unreadable && (
        <p role="alert" className="text-sm text-danger">
          The stored client secret cannot be read, so nobody can sign in through it. Enter it again below.
        </p>
      )}
      {available && state.trial && state.trialEndsAt && (
        <p className="text-sm text-text-muted" data-testid="sso-trial">
          Included in your trial until {day(state.trialEndsAt)}. It stops being offered then unless you choose Pro; what you enter here is kept.
        </p>
      )}
      {!available && (
        <p className="text-sm" data-testid="sso-upgrade">
          Your own identity provider is included in Pro and in the trial.{" "}
          {state.set && "What you entered is kept, and signing in through it comes back with Pro. "}
          <Link href="/settings/organisation" className="underline">
            See your plan
          </Link>
          .
        </p>
      )}
      {available && state.redirectUri && (
        <div className="space-y-1" data-testid="sso-redirect">
          <p className="text-sm">Register this redirect URI at your provider:</p>
          <code className="block break-all rounded border border-border bg-bg-input px-2 py-1 text-xs">{state.redirectUri}</code>
        </div>
      )}
      {available ? (
        <Form key={`${state.issuer}|${state.clientId}|${state.label}`} state={state} onSaved={onSaved} />
      ) : (
        state.set && (
          <dl className="space-y-1 text-sm">
            <div>
              <dt className="inline text-text-muted">Issuer: </dt>
              <dd className="inline break-all">{state.issuer}</dd>
            </div>
            <div>
              <dt className="inline text-text-muted">Client ID: </dt>
              <dd className="inline break-all">{state.clientId}</dd>
            </div>
          </dl>
        )
      )}
    </SettingsCard>
  );
}

export function SingleSignOn() {
  const api = useApi();
  const [answer, setAnswer] = useState<SsoAnswer | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setAnswer(await api.get("/api/settings/sso"));
    } catch {
      setFailed(true);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  if (failed) {
    return (
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold mb-1">Single sign-on</h2>
        <LoadFailed testId="sso-error" message="Failed to read the sign-in provider, so this page cannot say how people sign in." onRetry={load} />
      </div>
    );
  }
  if (!answer) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-semibold mb-1">Single sign-on</h2>
      {answer.hosted ? (
        <div className="space-y-4">
          <Card state={answer} onSaved={setAnswer} />
        </div>
      ) : (
        <p className="mb-4 text-sm text-text-muted" data-testid="sso-environment">
          On this instance the identity provider is set with environment variables, not here. The sign-in providers guide says how.
        </p>
      )}
    </div>
  );
}
