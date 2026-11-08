"use client";

import Link from "next/link";
import { FormEvent, useId, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SettingsCard } from "@/components/settings/SettingsCard";

export interface OwnMailServerState {
  hosted: true;
  plan: "free" | "pro";
  trial: boolean;
  trialEndsAt: string | null;
  available: boolean;
  set: boolean;
  host: string;
  port: number;
  user: string;
  fromAddress: string;
  fromName: string;
  unreadable: boolean;
  active: boolean;
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function RemovalDialog({ open, busy, onClose, onRemove }: { open: boolean; busy: boolean; onClose: () => void; onRemove: () => Promise<void> }) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={async () => {
        await onRemove();
        onClose();
      }}
      title="Remove your mail server?"
      message="Mail to your people goes through the service's own server again, from its address. You will need the password to add it again."
      confirmLabel="Remove"
      loadingLabel="Removing…"
      loading={busy}
    />
  );
}

function Form({ state, onSaved }: { state: OwnMailServerState; onSaved: (answer: OwnMailServerState) => void }) {
  const api = useApi();
  const { toast } = useToast();
  const errorId = useId();
  const [host, setHost] = useState(state.host);
  const [port, setPort] = useState(String(state.port));
  const [user, setUser] = useState(state.user);
  const [password, setPassword] = useState("");
  const [fromAddress, setFromAddress] = useState(state.fromAddress);
  const [fromName, setFromName] = useState(state.fromName);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // The stored password belongs to the server and login it was given for; the server asks again when one changes
  const needsPassword =
    !state.set || state.unreadable || host.trim().toLowerCase() !== state.host || Number(port) !== state.port || user.trim() !== state.user;
  const complete = host.trim() && port.trim() && user.trim() && fromAddress.trim() && (!needsPassword || password);

  async function send(work: () => Promise<OwnMailServerState>, done: string) {
    setBusy(true);
    setError("");
    try {
      const answer = await work();
      setPassword("");
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
    return send(
      () => api.put("/api/settings/smtp", { host: host.trim(), port: Number(port), user: user.trim(), password, fromAddress: fromAddress.trim(), fromName: fromName.trim() }),
      "Mail server saved"
    );
  };

  return (
    <>
      <form onSubmit={save} className="space-y-3" data-testid="smtp-form">
        <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
          <Input label="Host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" spellCheck={false} autoComplete="off" required />
          <Input label="Port" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" placeholder="587" autoComplete="off" required />
        </div>
        <Input label="Username" value={user} onChange={(e) => setUser(e.target.value)} spellCheck={false} autoComplete="off" required />
        <Input
          label="Password"
          type="password"
          // Not "off", which a password field ignores: this must not be filled with the admin's own login
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          spellCheck={false}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={state.set && !needsPassword ? "Stored" : ""}
          required={needsPassword}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        {state.set && !needsPassword && <p className="text-xs text-text-muted">Leave the password blank to keep the stored one.</p>}
        {state.set && needsPassword && !password && (
          <p className="text-xs text-text-muted" data-testid="smtp-password-needed">
            Enter the password to save: it is asked for again when the host, port or username changes.
          </p>
        )}
        <Input label="From address" type="email" value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} placeholder="boards@example.com" spellCheck={false} autoComplete="off" required />
        <Input label="Sender name (optional)" value={fromName} onChange={(e) => setFromName(e.target.value)} maxLength={80} placeholder="Acme boards" autoComplete="off" />
        <p className="text-xs text-text-muted">Saving signs in to your server first. Nothing is stored unless it accepts.</p>
        {error && (
          <p id={errorId} role="alert" className="text-sm text-danger break-words">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !complete}>
            {busy ? "Checking…" : state.set ? "Save changes" : "Save mail server"}
          </Button>
          {state.set && (
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setConfirming(true)}>
              Remove
            </Button>
          )}
        </div>
      </form>
      <RemovalDialog open={confirming} busy={busy} onClose={() => setConfirming(false)} onRemove={() => send(() => api.del("/api/settings/smtp"), "Mail server removed")} />
    </>
  );
}

function RemoveStored({ onSaved }: { onSaved: (answer: OwnMailServerState) => void }) {
  const api = useApi();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);

  async function remove() {
    setBusy(true);
    setError("");
    try {
      onSaved(await api.del("/api/settings/smtp"));
      toast("Mail server removed", "success");
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

export function OwnMailServer({ state, onSaved }: { state: OwnMailServerState; onSaved: (answer: OwnMailServerState) => void }) {
  const status = state.unreadable
    ? { label: "Cannot be read", on: false }
    : state.active
      ? { label: "Active", on: true }
      : state.set
        ? { label: "Saved, not used", on: false }
        : { label: "Not set up", on: false };

  return (
    <SettingsCard
      title="Your own mail server"
      description="Notifications, digests, invitations and password resets for your people go out through your SMTP server, from your address."
      status={status}
    >
      {state.unreadable && (
        <p role="alert" className="text-sm text-danger">
          The stored password cannot be read, so mail goes through the service&apos;s server.{state.available && " Enter it again below."}
        </p>
      )}
      {state.available && state.trial && state.trialEndsAt && (
        <p className="text-sm text-text-muted" data-testid="smtp-trial">
          Included in your trial until {day(state.trialEndsAt)} (UTC). From then on mail goes through the service&apos;s server unless you choose Pro; what you enter here is kept.
        </p>
      )}
      {!state.available && (
        <p className="text-sm" data-testid="smtp-upgrade">
          Your own mail server is included in Pro and in the trial.{" "}
          {state.set && "What you entered is kept, and mail goes through it again with Pro. "}
          <Link href="/settings/organisation" className="underline">
            See your plan
          </Link>
          .
        </p>
      )}
      {state.available ? (
        <Form key={`${state.host}|${state.port}|${state.user}|${state.fromAddress}|${state.fromName}`} state={state} onSaved={onSaved} />
      ) : (
        state.set && (
          <>
            <dl className="space-y-1 text-sm">
              <div>
                <dt className="inline text-text-muted">Server: </dt>
                <dd className="inline break-all">
                  {state.host}:{state.port}
                </dd>
              </div>
              <div>
                <dt className="inline text-text-muted">From: </dt>
                <dd className="inline break-all">{state.fromAddress}</dd>
              </div>
            </dl>
            <RemoveStored onSaved={onSaved} />
          </>
        )
      )}
    </SettingsCard>
  );
}
