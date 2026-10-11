"use client";

import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Switch } from "@/components/ui/Switch";
import { SettingsCard } from "@/components/settings/SettingsCard";

interface ProviderAnswer {
  hosted: boolean;
  enforced?: boolean;
  providers?: { id: string; label: string; enabled: boolean }[];
}

interface Warning {
  id: string;
  label: string;
  message: string;
}

export function SignInProviders() {
  const api = useApi();
  const { toast } = useToast();
  const [answer, setAnswer] = useState<ProviderAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState<Warning | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setAnswer(await api.get("/api/settings/sign-in-providers"));
    } catch {
      setFailed(true);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  async function set(id: string, label: string, enabled: boolean, confirm = false) {
    setBusy(id);
    setError("");
    try {
      setAnswer(await api.put("/api/settings/sign-in-providers", { provider: id, enabled, confirm }));
      setWarning(null);
      toast(`Sign-in with ${label} turned ${enabled ? "on" : "off"}`, "success");
    } catch (err) {
      const refusal = err as { status?: number; body?: { affected?: number } };
      if (refusal.status === 409 && typeof refusal.body?.affected === "number") {
        setWarning({ id, label, message: (err as Error).message });
      } else {
        setWarning(null);
        setError(err instanceof Error ? err.message : "Could not save.");
      }
    } finally {
      setBusy(null);
    }
  }

  if (failed) {
    return (
      <div className="max-w-2xl">
        <LoadFailed testId="sign-in-providers-error" message="Failed to read which sign-in providers are on." onRetry={load} />
      </div>
    );
  }
  if (!answer?.hosted || !answer.providers || answer.providers.length === 0) return null;

  return (
    <div className="max-w-2xl" data-testid="sign-in-providers">
      <SettingsCard
        title="Google and GitHub"
        description="Choose which of the shared sign-in providers your people are offered. Turning one off hides its button and refuses it on the server; accounts, links and open sessions stay as they are."
      >
        {answer.enforced && (
          <p className="text-sm text-text-muted" data-testid="sign-in-providers-enforced">
            Single sign-on is required, so Google and GitHub are closed whatever is set here.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <ul className="space-y-3">
          {answer.providers.map((provider) => (
            <li key={provider.id}>
              <Switch
                checked={provider.enabled}
                disabled={busy !== null}
                onChange={(on) => set(provider.id, provider.label, on)}
                label={`Sign in with ${provider.label}`}
                hint={provider.enabled ? `People can sign in and link ${provider.label}.` : `${provider.label} is not offered to anybody in this organisation.`}
              />
            </li>
          ))}
        </ul>
      </SettingsCard>
      <ConfirmDialog
        open={!!warning}
        onClose={() => setWarning(null)}
        onConfirm={() => warning && set(warning.id, warning.label, false, true)}
        title={`Turn off ${warning?.label ?? "sign-in"}?`}
        message={`${warning?.message ?? ""} Turn it back on, or have them set a password, to let them in again.`}
        confirmLabel="Turn off"
        loadingLabel="Turning off…"
        loading={busy !== null}
      />
    </div>
  );
}
