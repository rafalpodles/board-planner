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
  enforced?: boolean;
  adminGroup?: string;
  groupsClaim?: string;
  redirectUri?: string | null;
}

const TITLE = "Your identity provider";
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

// Removal is allowed on any plan: what an organisation stored stays stored after a downgrade, and it can take it away.
// The dialog stands outside the form: its buttons would otherwise submit it.
function RemovalDialog({ open, busy, onClose, onRemove }: { open: boolean; busy: boolean; onClose: () => void; onRemove: () => Promise<void> }) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={async () => {
        await onRemove();
        onClose();
      }}
      title="Remove your identity provider?"
      message="Signing in with it stops at once. People who only ever signed in through it use Forgot password to set a password. You will need the client secret to add it again."
      confirmLabel="Remove"
      loadingLabel="Removing…"
      loading={busy}
    />
  );
}

function RemoveStored({ onSaved }: { onSaved: (answer: SsoAnswer) => void }) {
  const api = useApi();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);

  async function remove() {
    setBusy(true);
    setError("");
    try {
      onSaved(await api.del("/api/settings/sso"));
      toast("Sign-in provider removed", "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="button" variant="secondary" disabled={busy} onClick={() => setConfirming(true)}>
        Remove
      </Button>
      <RemovalDialog open={confirming} busy={busy} onClose={() => setConfirming(false)} onRemove={remove} />
    </div>
  );
}

function Form({ state, onSaved }: { state: SsoAnswer; onSaved: (answer: SsoAnswer) => void }) {
  const api = useApi();
  const { toast } = useToast();
  const errorId = useId();
  const [label, setLabel] = useState(state.label ?? "Single sign-on");
  const [issuer, setIssuer] = useState(state.issuer ?? "");
  const [clientId, setClientId] = useState(state.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [adminGroup, setAdminGroup] = useState(state.adminGroup ?? "");
  const [groupsClaim, setGroupsClaim] = useState(state.groupsClaim ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // The stored secret belongs to the issuer and client it was given for; the server asks again when either changes
  const needsSecret = !state.set || state.unreadable === true || issuer.trim() !== state.issuer || clientId.trim() !== state.clientId;
  const issuerChanged = state.set === true && issuer.trim() !== state.issuer;

  async function send(work: () => Promise<SsoAnswer>, done: string) {
    setBusy(true);
    setError("");
    try {
      const answer = await work();
      setClientSecret("");
      onSaved(answer);
      toast(done, "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault();
    return send(() => api.put("/api/settings/sso", { issuer: issuer.trim(), clientId: clientId.trim(), clientSecret, label: label.trim(), adminGroup: adminGroup.trim(), groupsClaim: groupsClaim.trim() }), "Sign-in provider saved");
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
          placeholder={state.set && !needsSecret ? `Stored, ending in ${state.secretHint}` : ""}
          required={needsSecret}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        {state.set && !needsSecret && <p className="text-xs text-text-muted">Leave the client secret blank to keep the stored one.</p>}
        <Input label="Admin group (optional)" value={adminGroup} onChange={(e) => setAdminGroup(e.target.value)} maxLength={200} spellCheck={false} autoComplete="off" placeholder="board-planner-admins" />
        <Input label="Groups claim (optional)" value={groupsClaim} onChange={(e) => setGroupsClaim(e.target.value)} maxLength={100} spellCheck={false} autoComplete="off" placeholder="groups" />
        {adminGroup.trim() && (
          <p className="text-xs text-text-muted" data-testid="sso-admin-group-note">
            At each sign-in through this provider, people in this group become administrators and everybody else a member. The last administrator is never demoted. It is read at sign-in only, so a person already signed in keeps their role until they sign in again.
          </p>
        )}
        {issuerChanged && (
          <p className="text-xs text-text-muted" data-testid="sso-issuer-changed">
            Changing the issuer ends sign-in for everyone who linked the old one; they sign in another way and link it again.
          </p>
        )}
        {needsSecret && !clientSecret && issuer.trim() && clientId.trim() && (
          <p className="text-xs text-text-muted">Enter the client secret to save.</p>
        )}
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
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setConfirming(true)}>
              Remove
            </Button>
          )}
        </div>
      </form>
      <RemovalDialog open={confirming} busy={busy} onClose={() => setConfirming(false)} onRemove={() => send(() => api.del("/api/settings/sso"), "Sign-in provider removed")} />
    </>
  );
}

function Enforcement({ state, onSaved }: { state: SsoAnswer; onSaved: (answer: SsoAnswer) => void }) {
  const api = useApi();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const enforced = state.enforced === true;

  async function set(value: boolean) {
    setBusy(true);
    setError("");
    try {
      onSaved(await api.put("/api/settings/sso/enforce", { enforced: value }));
      toast(value ? "Single sign-on is now required" : "Single sign-on is no longer required", "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard
      title="Require single sign-on"
      description={`Everybody signs in only through ${state.label || "your provider"}. Password, Google and GitHub sign-in stop working for this organisation.`}
      status={{ label: enforced ? "Required" : "Not required", on: enforced }}
    >
      <p className="text-sm text-text-muted" data-testid="sso-enforce-warning">
        If your provider is set up wrong or goes down, nobody can sign in, you included, and this page cannot be opened to undo it. Sign in through it yourself before you turn this on.
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {enforced ? (
        <Button type="button" variant="secondary" disabled={busy} onClick={() => set(false)}>
          {busy ? "Saving…" : "Stop requiring single sign-on"}
        </Button>
      ) : (
        <Button type="button" disabled={busy} onClick={() => set(true)}>
          {busy ? "Saving…" : "Require single sign-on"}
        </Button>
      )}
    </SettingsCard>
  );
}

function Card({ state, onSaved }: { state: SsoAnswer; onSaved: (answer: SsoAnswer) => void }) {
  const available = state.available === true;
  const status = state.unreadable
    ? { label: "Cannot be read", on: false }
    : state.active
      ? { label: "Active", on: true }
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
          Included in your trial until {day(state.trialEndsAt)} (UTC). It stops being offered then unless you choose Pro; what you enter here is kept.
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
        <Form key={`${state.issuer}|${state.clientId}|${state.label}|${state.adminGroup}|${state.groupsClaim}`} state={state} onSaved={onSaved} />
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
      {!available && state.set && (
        <RemoveStored onSaved={onSaved} />
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
          {answer.active && <Enforcement state={answer} onSaved={setAnswer} />}
        </div>
      ) : (
        <p className="mb-4 text-sm text-text-muted" data-testid="sso-environment">
          On this instance the identity provider is set with environment variables, not here. The sign-in providers guide says how.
        </p>
      )}
    </div>
  );
}
