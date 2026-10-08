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

  const fallback = state.included
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
        label: state.unreadable ? "Cannot be read" : state.set ? "Your own key" : state.included ? (hosted ? "Included" : "Server key") : "Not set",
        on: !state.unreadable && (state.set || state.included),
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
        message={`${USE} They stop running on this key at once${
          hosted && plan === "free" ? ", and on the Free plan it does not run without one" : ""
        }. You will need the key to add it again.`}
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
      <KeyCard state={answer} onSaved={setAnswer} />
    </div>
  );
}
