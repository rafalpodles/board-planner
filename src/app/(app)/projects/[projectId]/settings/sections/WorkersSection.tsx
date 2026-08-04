"use client";

import { useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useDraft } from "@/hooks/use-draft";
import { useToast } from "@/components/ui/Toast";
import { Input } from "@/components/ui/Input";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { useDirtyGroup } from "@/components/settings/settings-context";
import { PROJECT_POLICY_DEFAULTS } from "@/lib/worker-policy";
import { projectRemotes, sameRepo } from "@/lib/repo-match";
import { ApiProject, ApiWorker } from "@/types";
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
type Draft = Record<string, PolicyValue>;

const FIELDS = Object.keys(PROJECT_POLICY_DEFAULTS);
const DEFAULTS = PROJECT_POLICY_DEFAULTS as unknown as Record<string, PolicyValue>;

// An inherited field shows the default rather than the stored copy of it: the two diverge once a
// default changes, and the default is what a worker will actually run under.
function draftFrom(project: ApiProject): Draft {
  const stored = (project.worker?.policy ?? {}) as unknown as Record<string, PolicyValue>;
  const pinned = new Set(project.worker?.policyOverrides ?? []);
  const draft: Draft = { enabled: !!project.worker?.enabled };
  for (const field of FIELDS) draft[field] = pinned.has(field) ? stored[field] : DEFAULTS[field];
  return draft;
}

export function WorkersSection({ projectId, project, replaceProject, isAdmin }: SectionProps) {
  const api = useApi();
  const { toast } = useToast();

  const [workers, setWorkers] = useState<ApiWorker[] | null>(null);
  const draft = useDraft<Draft>(draftFrom(project));
  // Un-pinning is intent, not a value, so it cannot live in the draft's diff: a field reset to the
  // default is byte-identical to one that was already inheriting it.
  const [unpinned, setUnpinned] = useState<Set<string>>(new Set());
  const pinned = new Set(project.worker?.policyOverrides ?? []);

  const wanted = projectRemotes(project);

  useEffect(() => {
    if (!isAdmin) return;
    api
      .get("/api/admin/workers")
      .then(setWorkers)
      .catch(() => setWorkers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  async function save(): Promise<void> {
    const policy: Record<string, PolicyValue> = {};
    for (const field of draft.dirtyKeys) {
      const name = String(field);
      if (name === "enabled" || unpinned.has(name)) continue;
      policy[name] = draft.value[name];
    }

    const patch: Record<string, unknown> = {};
    if (draft.isDirty("enabled")) patch.enabled = draft.value.enabled;
    if (Object.keys(policy).length > 0) patch.policy = policy;
    if (unpinned.size > 0) patch.reset = [...unpinned];
    if (Object.keys(patch).length === 0) return;

    try {
      const updated: ApiProject = await api.put(`/api/projects/${projectId}`, { worker: patch });
      replaceProject(updated);
      draft.commit(draftFrom(updated));
      setUnpinned(new Set());
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save worker settings", "error");
    }
  }

  useDirtyGroup(
    {
      id: "workers",
      section: "workers",
      label: "Workers",
      count:
        draft.count + [...unpinned].filter((f) => !draft.dirtyKeys.includes(f)).length,
    },
    {
      save,
      discard: () => {
        draft.discard();
        setUnpinned(new Set());
      },
    }
  );

  function resetField(field: string): void {
    draft.set(field, DEFAULTS[field]);
    setUnpinned((prev) => new Set(prev).add(field));
  }

  // Editing pins the field again, so a reset followed by a change does not send both
  function editField(field: string, value: PolicyValue): void {
    draft.set(field, value);
    setUnpinned((prev) => {
      if (!prev.has(field)) return prev;
      const next = new Set(prev);
      next.delete(field);
      return next;
    });
  }

  // Which machines could serve this project. A worker offers a checkout; the operator granted it
  // locally in repos.json, and no path is ever set from here.
  const offering = (workers ?? []).filter((w) =>
    (w.repos ?? []).some((r) => wanted.some((candidate) => sameRepo(candidate, r.remote)))
  );

  const contract = isAdmin ? "draft" : "readonly";

  return (
    <div className="space-y-6">
      <SettingsCard
        title="Autonomous workers"
        description="A worker claims approved tasks, runs the coding agent in its own checkout, and opens a pull request. Nothing runs until you enable it here."
        instanceScoped
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
                checked={!!draft.value.enabled}
                disabled={!isAdmin}
                onChange={(e) => draft.set("enabled", e.target.checked)}
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
        instanceScoped
      >
        <div className="space-y-3">
          {FIELDS.map((field) => {
            const value = draft.value[field];
            // What the row will mean once saved, not what is stored right now
            const inherits = unpinned.has(field) || (!pinned.has(field) && !draft.isDirty(field));
            return (
              <div key={field} className="flex items-center gap-3">
                <span className="w-52 text-sm">{LABELS[field] ?? field}</span>
                {typeof value === "boolean" ? (
                  <input
                    type="checkbox"
                    checked={value}
                    disabled={!isAdmin}
                    onChange={(e) => editField(field, e.target.checked)}
                  />
                ) : (
                  <Input
                    // Controlled: an uncontrolled input keeps showing the old number after a reset
                    // or a discard, under a label that has already changed
                    value={String(value)}
                    className="flex-1"
                    disabled={!isAdmin}
                    onChange={(e) =>
                      editField(
                        field,
                        NUMBER_FIELDS.has(field) ? Number(e.target.value) : e.target.value
                      )
                    }
                  />
                )}
                {inherits ? (
                  <span className="text-xs text-text-muted w-24">default</span>
                ) : (
                  <button
                    type="button"
                    disabled={!isAdmin}
                    onClick={() => resetField(field)}
                    className="text-xs text-primary hover:underline w-24 text-left disabled:text-text-muted disabled:no-underline"
                    title="Follow the default again"
                  >
                    set · reset
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </SettingsCard>
    </div>
  );
}
