"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { SettingsCard } from "@/components/settings/SettingsCard";

type ProviderName = "openrouter" | "openai";

interface ProviderState {
  set: boolean;
  hint: string;
  included: boolean;
}

interface AiKeysAnswer {
  hosted: boolean;
  plan: "free" | "pro";
  providers: Record<ProviderName, ProviderState>;
}

const PROVIDERS: { name: ProviderName; field: string; title: string; use: string; placeholder: string }[] = [
  {
    name: "openrouter",
    field: "openrouterKey",
    title: "OpenRouter key",
    use: "Runs the PM agent: the chat, the scheduled board reviews and the review of a task that needs a person.",
    placeholder: "sk-or-v1-…",
  },
  {
    name: "openai",
    field: "openaiKey",
    title: "OpenAI key",
    use: "Runs AI Assist, which drafts a task from a sentence.",
    placeholder: "sk-…",
  },
];

function KeyCard({
  provider,
  state,
  hosted,
  onSaved,
}: {
  provider: (typeof PROVIDERS)[number];
  state: ProviderState;
  hosted: boolean;
  onSaved: (answer: AiKeysAnswer) => void;
}) {
  const api = useApi();
  const { toast } = useToast();
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(body: Record<string, string | null>, done: string) {
    setBusy(true);
    setError("");
    try {
      const answer: AiKeysAnswer = await api.put("/api/settings/ai-keys", body);
      setValue("");
      onSaved(answer);
      toast(done, "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the key.");
    } finally {
      setBusy(false);
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault();
    return send({ [provider.field]: value.trim() }, `${provider.title} saved`);
  };

  const fallback = state.included
    ? hosted
      ? "Without a key of your own it runs on ours, which your plan includes."
      : "Without a key of your own it runs on the key this server was set up with."
    : hosted
      ? "Without a key of your own it does not run on the Free plan."
      : "Without a key of your own it does not run: no key was set on the server.";

  return (
    <SettingsCard
      title={provider.title}
      description={provider.use}
      status={{ label: state.set ? "Your own key" : state.included ? "Included" : "Not set", on: state.set || state.included }}
    >
      {state.set ? (
        <p className="text-sm">
          A key ending in <code>{state.hint}</code> is stored. It is used first, and nothing caps it here.
        </p>
      ) : (
        <p className="text-sm text-text-muted">{fallback}</p>
      )}

      <form onSubmit={save} className="space-y-3">
        <Input
          label={state.set ? "Replace the key" : "Add your key"}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={provider.placeholder}
          error={error}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || value.trim().length === 0}>
            {busy ? "Saving…" : state.set ? "Replace key" : "Save key"}
          </Button>
          {state.set && (
            <Button type="button" variant="secondary" disabled={busy} onClick={() => send({ [provider.field]: null }, `${provider.title} removed`)}>
              Remove key
            </Button>
          )}
        </div>
      </form>
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

  if (failed) {
    return (
      <LoadFailed
        testId="ai-keys-error"
        message="Failed to read the AI keys, so this page cannot say which key runs the AI."
        onRetry={load}
      />
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
      <p className="mb-4 text-sm text-text-muted">
        {answer.hosted
          ? "Your own key is used first, on every plan, and nothing caps it. Pro and the trial can also use ours."
          : "Your own key is used first and nothing caps it. Without one, the key the server was set up with is used."}{" "}
        {answer.hosted && answer.plan === "free" && (
          <>
            <Link href="/settings/organisation" className="underline">
              See your plan
            </Link>
            .
          </>
        )}
      </p>
      {PROVIDERS.map((provider) => (
        <KeyCard
          key={provider.name}
          provider={provider}
          state={answer.providers[provider.name]}
          hosted={answer.hosted}
          onSaved={setAnswer}
        />
      ))}
    </div>
  );
}
