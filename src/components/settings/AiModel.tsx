"use client";

import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { ModelPicker, type ModelCatalogue } from "@/components/settings/ModelPicker";
import { APP_NAME } from "@/lib/brand";

export function AiModel() {
  const api = useApi();
  const { toast } = useToast();
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null);
  const [saved, setSaved] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const answer: ModelCatalogue = await api.get("/api/settings/ai-models");
      setCatalogue(answer);
      setSaved(answer.model);
      setValue(answer.model);
    } catch {
      setFailed(true);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      await api.put("/api/settings", { aiModel: value.trim() });
      setSaved(value.trim());
      toast("Model saved", "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the model.");
    } finally {
      setBusy(false);
    }
  }

  if (failed) return <LoadFailed testId="ai-model-error" message="Failed to read the models this key runs." onRetry={load} />;
  if (!catalogue) return null;

  const providers = catalogue.providers?.map((p) => p.label).join(", ");
  return (
    <SettingsCard
      title="Model"
      description="One model for the PM agent and for drafting a task with AI. A project can name its own PM model under Settings → PM Agents."
    >
      <div data-testid="ai-model-card" className="space-y-3">
        {catalogue.restricted ? (
          <p className="text-sm text-text-muted" data-testid="ai-model-note">
            {APP_NAME}&apos;s key runs only {providers} models. To use any other model or provider, add your own OpenRouter key above.
          </p>
        ) : (
          <p className="text-sm text-text-muted" data-testid="ai-model-note">
            Any OpenRouter model runs on this key: pick one from the list or type a name, such as <code>anthropic/claude-haiku-5.5</code>.
          </p>
        )}
        <ModelPicker
          label="Model"
          value={value}
          onChange={(next) => {
            setValue(next);
            setError("");
          }}
          catalogue={catalogue}
        />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button onClick={save} disabled={busy || !value.trim() || value.trim() === saved}>
          {busy ? "Saving…" : "Save model"}
        </Button>
      </div>
    </SettingsCard>
  );
}
