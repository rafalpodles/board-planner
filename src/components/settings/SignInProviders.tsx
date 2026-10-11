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
  passwordSignIn?: boolean;
  providers?: { id: string; label: string; enabled: boolean }[];
}

interface Warning {
  id: string;
  label: string;
  message: string;
  error?: string;
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
      const message = err instanceof Error ? err.message : "Could not save.";
      if (refusal.status === 409 && typeof refusal.body?.affected === "number") {
        setWarning({ id, label, message });
      } else if (confirm) {
        // The question is still open and the reason belongs in it, not behind it
        setWarning((open) => (open ? { ...open, error: message } : open));
      } else {
        setWarning(null);
        setError(message);
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
        title={answer.providers.map((provider) => provider.label).join(" and ")}
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
                // Not disabled while it saves: a control that becomes disabled drops keyboard focus
                onChange={(on) => busy === null && set(provider.id, provider.label, on)}
                label={`Sign in with ${provider.label}`}
                hint={
                  !provider.enabled
                    ? `${provider.label} is not offered to anybody in this organisation.`
                    : answer.enforced
                      ? "Switched on, but closed while your own single sign-on is required."
                      : `People can sign in and link ${provider.label}.`
                }
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
        message={`${warning?.message ?? ""} Their open sessions stay active. To let them back in, turn ${warning?.label ?? "it"} on again${answer.passwordSignIn === false ? "." : ", or they can use Forgot password to set a password."}`}
        error={warning?.error}
        confirmLabel="Turn off"
        loadingLabel="Turning off…"
        loading={busy !== null}
      />
    </div>
  );
}
