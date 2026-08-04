"use client";

import { useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { Input } from "@/components/ui/Input";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { PROJECT_POLICY_DEFAULTS } from "@/lib/worker-policy";
import { projectRemotes, sameRepo } from "@/lib/repo-match";
import { ApiWorker } from "@/types";
import { SectionProps } from "./types";

const NUMBER_FIELDS = new Set(["taskTimeoutMs", "maxDiffLines", "maxDiffFiles"]);
const LABELS: Record<string, string> = {
  autoMerge: "Merge automatically",
  baseBranch: "Base branch",
  taskTimeoutMs: "Task timeout (ms)",
  maxDiffLines: "Largest diff (lines)",
  maxDiffFiles: "Largest diff (files)",
  model: "Model",
  fallbackModel: "Fallback model",
  reviewModel: "Review model",
};

type PolicyValue = string | number | boolean;

export function WorkersSection({ projectId, project, patchProject, isAdmin }: SectionProps) {
  const api = useApi();
  const { toast } = useToast();

  const [workers, setWorkers] = useState<ApiWorker[] | null>(null);
  const [saving, setSaving] = useState(false);

  const config = project.worker;
  // Both integrations, matching what the server does — considering one would show "None yet"
  // for a machine holding the other checkout while the server assigned it anyway.
  const wanted = projectRemotes(project);

  useEffect(() => {
    if (!isAdmin) return;
    api
      .get("/api/admin/workers")
      .then(setWorkers)
      .catch(() => setWorkers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  async function save(patch: Record<string, unknown>) {
    setSaving(true);
    try {
      const updated = await api.put(`/api/projects/${projectId}`, { worker: patch });
      patchProject({ worker: updated.worker });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save", "error");
    } finally {
      setSaving(false);
    }
  }

  const overrides = new Set(config?.policyOverrides ?? []);
  const valueOf = (field: string): PolicyValue => {
    const stored = (config?.policy ?? {}) as unknown as Record<string, PolicyValue>;
    // An inherited field shows the default rather than the stored copy of it: they diverge once a
    // default changes, and the default is what a worker will actually run under.
    return overrides.has(field)
      ? stored[field]
      : (PROJECT_POLICY_DEFAULTS as Record<string, PolicyValue>)[field];
  };

  // Which machines could serve this project. A worker offers a checkout; the operator granted it
  // locally in repos.json, and no path is ever set from here.
  const offering = (workers ?? []).filter((w) =>
    (w.repos ?? []).some((r) => wanted.some((candidate) => sameRepo(candidate, r.remote)))
  );

  return (
    <div className="space-y-6">
      <SettingsCard
        title="Autonomous workers"
        description="A worker claims approved tasks, runs the coding agent in its own checkout, and opens a pull request. Nothing runs until you enable it here."
      >
        {!project.githubRepo && !project.gitlabRepo ? (
          <p className="text-sm text-danger">
            This project names no repository, so no machine can be matched to it. Set the GitHub or
            GitLab repository under Integrations first.
          </p>
        ) : (
          <>
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={!!config?.enabled}
                disabled={!isAdmin || saving}
                onChange={(e) => save({ enabled: e.target.checked })}
              />
              <span>Let workers run tasks for this project</span>
            </label>

            <div className="mt-4">
              <p className="text-sm font-medium mb-2">Machines offering this repository</p>
              {workers === null ? (
                <p className="text-sm text-text-muted">Loading…</p>
              ) : offering.length === 0 ? (
                <p className="text-sm text-text-muted">
                  None yet. A machine appears here once its worker reports a checkout of{" "}
                  <code className="text-text">{project.githubRepo || project.gitlabRepo}</code> —
                  granted locally in <code className="text-text">repos.json</code> on that machine,
                  never set from here.
                </p>
              ) : (
                <ul className="border border-border rounded-lg divide-y divide-border">
                  {offering.map((w) => (
                    <li key={w._id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <span className="font-medium">{w.name}</span>
                      <span className="text-text-muted">{w.host}</span>
                      <span className={`ml-auto text-xs ${w.stale ? "text-danger" : "text-success"}`}>
                        {w.stale ? "not reporting" : "live"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </SettingsCard>

      <SettingsCard
        title="How work is done here"
        description="These describe this repository, so every machine serving it runs under the same values. A field you have not set follows the default."
      >
        <div className="space-y-3">
          {Object.keys(PROJECT_POLICY_DEFAULTS).map((field) => {
            const value = valueOf(field);
            const inherited = !overrides.has(field);
            return (
              <div key={field} className="flex items-center gap-3">
                <span className="w-52 text-sm">{LABELS[field] ?? field}</span>
                {typeof value === "boolean" ? (
                  <input
                    type="checkbox"
                    checked={value}
                    disabled={!isAdmin || saving}
                    onChange={(e) => save({ policy: { [field]: e.target.checked } })}
                  />
                ) : (
                  <Input
                    className="flex-1"
                    defaultValue={String(value)}
                    disabled={!isAdmin || saving}
                    onBlur={(e) => {
                      const raw = e.target.value.trim();
                      if (!raw || raw === String(value)) return;
                      save({
                        policy: { [field]: NUMBER_FIELDS.has(field) ? Number(raw) : raw },
                      });
                    }}
                  />
                )}
                <span className="text-xs text-text-muted w-16">
                  {inherited ? "default" : "set"}
                </span>
              </div>
            );
          })}
        </div>
        {!isAdmin && (
          <p className="text-xs text-text-muted mt-3">
            Only an instance admin can change these — enabling a project commits somebody&apos;s
            machine to running agent-written code.
          </p>
        )}
      </SettingsCard>
    </div>
  );
}
