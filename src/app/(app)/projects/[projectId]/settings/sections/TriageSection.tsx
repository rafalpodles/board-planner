"use client";

import { useApi } from "@/hooks/use-api";
import { useDraft } from "@/hooks/use-draft";
import { useEntitlement } from "@/hooks/use-entitlement";
import { useToast } from "@/components/ui/Toast";
import { Select } from "@/components/ui/Select";
import { ProUpsell } from "@/components/ui/ProUpsell";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { useDirtyGroup } from "@/components/settings/settings-context";
import { ApiProject, TriageMode } from "@/types";
import { SectionProps } from "./types";

const MODES: { value: TriageMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "suggest", label: "Suggest on the task" },
  { value: "auto", label: "Apply, with an undo" },
];

export function TriageSection({ projectId, project, replaceProject }: SectionProps) {
  const api = useApi();
  const { toast } = useToast();
  const entitlement = useEntitlement("ai.triage");
  const draft = useDraft({ triageMode: project.triageMode ?? "off" });

  useDirtyGroup(
    { id: "triage", section: "triage", label: "AI triage", count: draft.dirtyKeys.length },
    {
      save: async () => {
        try {
          const saved: ApiProject = await api.put(`/api/projects/${projectId}`, { triageMode: draft.value.triageMode });
          replaceProject(saved);
          draft.commit({ triageMode: saved.triageMode ?? "off" });
        } catch (error) {
          toast(error instanceof Error ? error.message : "Could not save AI triage", "error");
        }
      },
      discard: draft.discard,
    }
  );

  if (entitlement.loading) return <p className="text-sm text-text-muted">Loading…</p>;
  if (!entitlement.entitled) {
    return (
      <>
        <ProUpsell title="AI triage">
          Each new task gets a suggested assignee, category and choice fields, with the reason for each.
        </ProUpsell>
        {/* A board kept its mode through a downgrade; turning it off needs no plan */}
        {project.triageMode && project.triageMode !== "off" && (
          <div className="mt-4 max-w-sm">
            <Select
              label="AI triage"
              value={draft.value.triageMode}
              onChange={(e) => draft.set("triageMode", e.target.value as TriageMode)}
              options={MODES.filter((m) => m.value === "off" || m.value === project.triageMode)}
            />
          </div>
        )}
      </>
    );
  }

  return (
    <SettingsCard title="New tasks" status={{ label: draft.value.triageMode === "off" ? "Off" : "On", on: draft.value.triageMode !== "off" }}>
      <div className="max-w-sm">
        <Select
          label="AI triage"
          value={draft.value.triageMode}
          onChange={(e) => draft.set("triageMode", e.target.value as TriageMode)}
          options={MODES}
        />
      </div>
      <p className="mt-2 text-sm text-text-muted">
        Suggests a category, and an assignee and choice fields where the person creating the task left them empty. Suggestions are shown on the task, or
        applied and recorded in its history as AI triage.
      </p>
    </SettingsCard>
  );
}
