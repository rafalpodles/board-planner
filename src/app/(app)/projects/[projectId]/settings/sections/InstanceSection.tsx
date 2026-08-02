"use client";

import { useEffect } from "react";
import { useApi } from "@/hooks/use-api";
import { useDraft } from "@/hooks/use-draft";
import { useToast } from "@/components/ui/Toast";
import { Input } from "@/components/ui/Input";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { useDirtyGroup } from "@/components/settings/settings-context";

export function InstanceSection() {
  const api = useApi();
  const { toast } = useToast();
  const draft = useDraft({ aiModel: "" });

  useEffect(() => {
    api
      .get("/api/settings")
      .then((s: { aiModel: string }) => draft.commit({ aiModel: s.aiModel || "" }))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useDirtyGroup(
    { id: "instance-ai-model", section: "instance", label: "AI model", count: draft.count },
    {
      save: async () => {
        if (!draft.value.aiModel.trim()) return;
        try {
          const res = await api.put("/api/settings", { aiModel: draft.value.aiModel.trim() });
          draft.commit({ aiModel: res.aiModel });
          toast("AI model saved", "success");
        } catch (err) {
          toast(err instanceof Error ? err.message : "Failed to save AI model", "error");
        }
      },
      discard: draft.discard,
    }
  );

  return (
    <>
      <div className="mb-4 flex gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
        <span aria-hidden="true">⚠</span>
        <p>
          <strong className="font-semibold">This applies to every project on the instance</strong>, not
          just this one.
        </p>
      </div>
      <SettingsCard title="Model" contract="draft" instanceScoped>
        <div>
          <Input
            label="OpenAI model"
            value={draft.value.aiModel}
            dirty={draft.isDirty("aiModel")}
            onChange={(e) => draft.set("aiModel", e.target.value)}
            placeholder="gpt-4o-mini"
          />
          <p className="mt-1 text-xs text-text-muted">
            Used when generating tasks with AI. For example gpt-4o-mini, gpt-4o, gpt-4.1-mini.
          </p>
        </div>
      </SettingsCard>
    </>
  );
}
