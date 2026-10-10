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

interface AiKeysAnswer {
  hosted: boolean;
  plan: "free" | "pro";
  set: boolean;
  hint: string;
  unreadable: boolean;
  included: boolean;
  usage: UsageAnswer;
}

interface UsageAnswer {
  scope: "month" | "trial";
  used: number;
  limit: number | null;
  resetsAt: string | null;
  today: number;
  dailyCeiling: number | null;
  ownTokens: number;
  calls: number;
  ownCalls: number;
  turns: number | null;
  locked: boolean;
  included: boolean;
}

const tokens = (n: number) => n.toLocaleString("en-US");
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function UsageCard({ usage, hosted }: { usage: UsageAnswer; hosted: boolean }) {
  const period = usage.scope === "trial" ? "in your trial" : "this month";
  const share = usage.limit ? Math.min(100, Math.floor((usage.used / usage.limit) * 100)) : null;
  return (
    <SettingsCard
      title="AI usage"
      description="Counted in tokens on every call of the PM agent and AI Assist."
      status={
        usage.included
          ? { label: usage.locked ? "Switched off" : share === null ? "Not limited" : `${share}% used`, on: !usage.locked && (share === null || share < 100) }
          : { label: "Your own key", on: true }
      }
    >
      {usage.included && usage.locked && (
        <p role="alert" data-testid="ai-usage-locked" className="text-sm text-danger">
          The operator has switched off the use of its key for this organisation.{" "}
          {hosted ? "Add your own key below to keep going." : ""}
        </p>
      )}
      {usage.included && (
        <>
          <p className="text-sm" data-testid="ai-usage-month">
            <strong>{tokens(usage.used)}</strong>
            {usage.limit !== null ? <> of <strong>{tokens(usage.limit)}</strong></> : null} tokens used {period}
            {usage.limit === null ? ", and nothing limits them" : ""}.
            {usage.resetsAt && usage.limit !== null ? <> It renews on {day(usage.resetsAt)} (UTC).</> : null}
          </p>
          {share !== null && usage.limit !== null && (
            <div
              role="progressbar"
              aria-label={`AI tokens used ${period}`}
              aria-valuemin={0}
              aria-valuemax={usage.limit}
              aria-valuenow={Math.min(usage.used, usage.limit)}
              className="h-2 w-full overflow-hidden rounded-full bg-bg-input"
            >
              <div className={`h-full ${share >= 90 ? "bg-danger" : "bg-primary"}`} style={{ width: `${share}%` }} />
            </div>
          )}
          {usage.turns !== null && (
            <p className="text-sm text-text-muted" data-testid="ai-usage-activity">
              <strong className="text-text">{tokens(usage.turns)}</strong> PM turn{usage.turns === 1 ? "" : "s"} and{" "}
              <strong className="text-text">{tokens(usage.calls)}</strong> model call{usage.calls === 1 ? "" : "s"} on this service&apos;s key {period}.
            </p>
          )}
          <p className="text-sm text-text-muted" data-testid="ai-usage-today">
            Today (UTC): {tokens(usage.today)} tokens
            {usage.dailyCeiling !== null ? <>; one day may use at most {tokens(usage.dailyCeiling)}</> : null}.
          </p>
        </>
      )}
      {usage.ownTokens > 0 && (
        <p className="text-sm text-text-muted" data-testid="ai-usage-own">
          Your own key: {tokens(usage.ownTokens)} tokens in {tokens(usage.ownCalls)} call{usage.ownCalls === 1 ? "" : "s"} {period}, counted and never limited.
        </p>
      )}
    </SettingsCard>
  );
}

const TITLE = "OpenRouter key";
const USE =
  "Runs the PM agent (the chat, the scheduled board reviews and the review of a task that needs a person) and AI Assist, which drafts a task from a sentence.";

function KeyCard({ state, onSaved }: { state: AiKeysAnswer; onSaved: (answer: AiKeysAnswer) => void }) {
  const { hosted, plan } = state;
  const errorId = useId();
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const api = useApi();
  const { toast } = useToast();
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(openrouterKey: string | null, done: string) {
    setBusy(true);
    setError("");
    try {
      const answer: AiKeysAnswer = await api.put("/api/settings/ai-keys", { openrouterKey });
      setValue("");
      setConfirmingRemoval(false);
      onSaved(answer);
      toast(done, "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the key.");
      setConfirmingRemoval(false);
    } finally {
      setBusy(false);
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault();
    // An empty key reaches the server as "remove", so a blank is never sent
    if (!value.trim()) return;
    return send(value.trim(), `${TITLE} saved`);
  };

  const switchedOff = state.included && Boolean(state.usage?.locked);
  const fallback = switchedOff
    ? "Without a key of your own it does not run: the operator has switched ours off for this organisation."
    : state.included
    ? hosted
      ? "Without a key of your own it runs on ours, which your plan includes."
      : "Without a key of your own it runs on the key this server was set up with."
    : hosted
      ? plan === "free"
        ? "Without a key of your own it does not run on the Free plan."
        : "Without a key of your own it does not run: this service has no key to offer."
      : "Without a key of your own it does not run: no key was set on the server.";

  return (
    <SettingsCard
      title={TITLE}
      description={USE}
      status={{
        label: state.unreadable ? "Cannot be read" : state.set ? "Your own key" : switchedOff ? "Switched off" : state.included ? (hosted ? "Included" : "Server key") : "Not set",
        on: !state.unreadable && (state.set || (state.included && !switchedOff)),
      }}
    >
      {state.unreadable ? (
        <p role="alert" className="text-sm text-danger">
          The stored key cannot be read, so every call fails. Enter it again below.
        </p>
      ) : state.set ? (
        <p className="text-sm">
          {state.hint ? (
            <>
              A key ending in <code>{state.hint}</code> is stored.
            </>
          ) : (
            "A key is stored."
          )}{" "}
          It is used first.
        </p>
      ) : (
        <p className="text-sm text-text-muted">{fallback}</p>
      )}

      <form onSubmit={save} className="space-y-3">
        <Input
          label={state.set ? "Replace your OpenRouter key" : "Add your OpenRouter key"}
          type="password"
          // Not "off", which a password field ignores: this must not be filled with the admin's own login
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          spellCheck={false}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError("");
          }}
          placeholder="sk-or-v1-…"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={error ? "border-danger" : ""}
        />
        {error && (
          <p id={errorId} role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || value.trim().length === 0}>
            {busy ? "Saving…" : state.set ? "Replace key" : "Save key"}
          </Button>
          {state.set && (
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setConfirmingRemoval(true)}>
              Remove key
            </Button>
          )}
        </div>
      </form>

      <ConfirmDialog
        open={confirmingRemoval}
        onClose={() => setConfirmingRemoval(false)}
        onConfirm={() => send(null, `${TITLE} removed`)}
        title="Remove the OpenRouter key?"
        message={`The PM agent and AI Assist stop using this key at once. ${
          state.included
            ? "They fall back to the key this instance offers."
            : hosted && plan === "free"
              ? "On the Free plan they do not run without one."
              : "They do not run without one."
        } You will need the key to add it again.`}
        confirmLabel="Remove key"
        loadingLabel="Removing…"
        loading={busy}
      />
    </SettingsCard>
  );
}

export function AiKeys() {
  const api = useApi();
  const [answer, setAnswer] = useState<AiKeysAnswer | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setAnswer(await api.get("/api/settings/ai-keys"));
    } catch {
      setFailed(true);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  // The heading waits for the answer, as the neighbouring screens' do: it is what says the page has loaded
  if (failed) {
    return (
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold mb-1">AI key</h2>
        <LoadFailed
          testId="ai-keys-error"
          message="Failed to read the AI key, so this page cannot say which key runs the AI."
          onRetry={load}
        />
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
      <h2 className="text-lg font-semibold mb-1">AI key</h2>
      <p className="mb-4 text-sm text-text-muted">
        {answer.hosted
          ? "Your own key is used first, on every plan. Pro and the trial can also use ours."
          : "Your own key is used first. Without one, the key the server was set up with is used."}{" "}
        {answer.hosted && answer.plan === "free" && (
          <>
            <Link href="/settings/organisation" className="underline">
              See your plan
            </Link>
            .
          </>
        )}
      </p>
      <div className="space-y-4">
        {answer.usage && (answer.usage.included || answer.usage.ownTokens > 0) && <UsageCard usage={answer.usage} hosted={answer.hosted} />}
        <KeyCard state={answer} onSaved={setAnswer} />
      </div>
    </div>
  );
}
