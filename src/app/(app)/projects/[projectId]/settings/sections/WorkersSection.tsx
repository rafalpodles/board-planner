"use client";

import { useEffect, useId, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useDraft } from "@/hooks/use-draft";
import { useToast } from "@/components/ui/Toast";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { useDirtyGroup } from "@/components/settings/settings-context";
import { PROJECT_POLICY_DEFAULTS } from "@/lib/worker-policy";
import { projectRemotes, sameRepo } from "@/lib/repo-match";
import { ApiAgentRun, ApiProject, ApiWorker } from "@/types";
import { SectionProps } from "./types";
import { endedBadly, endState } from "@/lib/run-outcome";
import Link from "next/link";
import { useStore } from "@/app/(app)/agents/store";

const NUMBER_FIELDS = new Set(["taskTimeoutMs", "runCeilingMs", "maxDiffLines", "maxDiffFiles"]);
const LABELS: Record<string, string> = {
  autoMerge: "Merge automatically",
  reviewGate: "Review the diff before delivering",
  baseBranch: "Base branch",
  taskTimeoutMs: "Timeout for one step (ms)",
  runCeilingMs: "Timeout for the whole run (ms)",
  maxDiffLines: "Largest diff (lines)",
  maxDiffFiles: "Largest diff (files)",
  model: "Model",
  fallbackModel: "Fallback model",
  reviewModel: "Review model",
};

type PolicyValue = string | number | boolean;
type Draft = Record<string, PolicyValue>;

const MOVED_TO_BLOCKS = new Set([
  "autoMerge",
  "maxDiffLines",
  "maxDiffFiles",
  "reviewGate",
  "reviewModel",
  "model",
  "fallbackModel",
]);

const FIELDS = Object.keys(PROJECT_POLICY_DEFAULTS).filter((f) => !MOVED_TO_BLOCKS.has(f));
const DEFAULTS = PROJECT_POLICY_DEFAULTS as unknown as Record<string, PolicyValue>;

function draftFrom(project: ApiProject): Draft {
  const stored = (project.worker?.policy ?? {}) as unknown as Record<string, PolicyValue>;
  const pinned = new Set(project.worker?.policyOverrides ?? []);
  const draft: Draft = {
    enabled: !!project.worker?.enabled,
  };
  for (const field of FIELDS) draft[field] = pinned.has(field) ? stored[field] : DEFAULTS[field];
  return draft;
}

export function WorkersSection({ projectId, project, replaceProject, isAdmin }: SectionProps) {
  const defaultAgentId = useId();
  const policyFieldId = useId();
  const store = useStore();
  const agentApi = useApi();
  const [defaultAgent, setDefaultAgent] = useState(String(project.worker?.agent ?? ""));
  const [runs, setRuns] = useState<ApiAgentRun[]>([]);

  useEffect(() => {
    agentApi
      .get(`/api/projects/${projectId}/runs?limit=10`)
      .then((r) => setRuns(Array.isArray(r) ? (r as ApiAgentRun[]) : []))
      .catch(() => setRuns([]));
  }, [agentApi, projectId]);

  const saveDefaultAgent = async (agentId: string) => {
    const previous = defaultAgent;
    setDefaultAgent(agentId);
    try {
      await agentApi.put(`/api/projects/${projectId}/agent`, { agentId });
    } catch (error) {
      setDefaultAgent(previous);
      toast(error instanceof Error ? error.message : "Could not set the default agent", "error");
    }
  };
  const api = useApi();
  const { toast } = useToast();

  const [workers, setWorkers] = useState<ApiWorker[] | null>(null);
  const draft = useDraft<Draft>(draftFrom(project));
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

  function editField(field: string, value: PolicyValue): void {
    draft.set(field, value);
    setUnpinned((prev) => {
      if (!prev.has(field)) return prev;
      const next = new Set(prev);
      next.delete(field);
      return next;
    });
  }

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
        {!project.repositoryUrl ? (
          <p className="text-sm text-danger">
            This project names no repository, so no machine can be matched to it. Set the GitHub or
            GitLab repository under Integrations first.
          </p>
        ) : (
          <>
            <Switch
              checked={!!draft.value.enabled}
              disabled={!isAdmin}
              onChange={(v) => draft.set("enabled", v)}
              label="Let workers run tasks for this project"
              hint="A task goes to the machine of the person it is assigned to, once it names an agent."
            />

            <div className="mt-4">
              <p className="text-sm font-medium mb-2">Machines offering this repository</p>
              {workers === null ? (
                <p className="text-sm text-text-muted">Loading…</p>
              ) : offering.length === 0 ? (
                <p className="text-sm text-text-muted">
                  None yet. A machine appears here once its worker reports a checkout of{" "}
                  <code className="text-text">{project.repositoryUrl}</code> —
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
        <p className="mb-3 text-xs text-text-muted">
          Diff limits, review, merging and the models moved to the{" "}
          <Link href="/agents" className="text-primary hover:underline">
            steps and gates
          </Link>{" "}
          that do them.
        </p>
        <div className="space-y-3">
          {FIELDS.map((field) => {
            const value = draft.value[field];
            const label = LABELS[field] ?? field;
            const fieldId = `${policyFieldId}-${field}`;
            const inherits = unpinned.has(field) || (!pinned.has(field) && !draft.isDirty(field));
            return (
              <div key={field} className="flex items-center gap-3">
                {typeof value !== "boolean" && (
                  <label htmlFor={fieldId} className="w-52 text-sm">
                    {label}
                  </label>
                )}
                {typeof value === "boolean" ? (
                  <Switch
                    checked={value}
                    disabled={!isAdmin}
                    onChange={(v) => editField(field, v)}
                    label={label}
                  />
                ) : (
                  <Input
                    id={fieldId}
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
                    aria-label={`set · reset ${label}`}
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

      <SettingsCard
        title="Agent"
        description="Offered first when somebody picks the agent for a task here. It runs nothing by itself — a task with no agent chosen is one a person is doing."
      >
        <div className="max-w-md">
          <label htmlFor={defaultAgentId} className="text-sm font-medium mb-2 block">
            Default agent
          </label>
          <select
            id={defaultAgentId}
            value={defaultAgent}
            disabled={!isAdmin || store.loading}
            onChange={(e) => saveDefaultAgent(e.target.value)}
            className="w-full rounded-lg border border-border bg-bg-input min-h-11 px-2 py-1.5 text-sm sm:min-h-0"
          >
            <option value="">No default — the task picker starts empty</option>
            {store.allAgents
              .filter(
                (a) =>
                  a.scope !== "user" &&
                  (a.scope !== "project" || a.projectId === String(project._id))
              )
              .map((a) => (
                <option key={a._id} value={a._id}>
                  {a.name}
                </option>
              ))}
          </select>
          <p className="mt-1 text-xs text-text-muted">
            {store.allAgents.find((a) => a._id === defaultAgent)?.description ?? ""}{" "}
            <Link href="/agents" className="text-primary hover:underline">
              Manage agents
            </Link>
          </p>
        </div>

        <div className="mt-6">
          <p className="text-sm font-medium mb-2">Recent runs</p>
          {runs.length === 0 ? (
            <p className="text-xs text-text-muted">Nothing has run yet.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-bg-input text-xs text-text-muted">
                    <th className="px-3 py-2 text-left font-normal">Task</th>
                    <th className="px-3 py-2 text-left font-normal">Agent</th>
                    <th className="px-3 py-2 text-left font-normal">Outcome</th>
                    <th className="px-3 py-2 text-right font-normal">Took</th>
                    <th className="px-3 py-2 text-right font-normal">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run._id} className="border-b border-border last:border-0">
                      <td className="px-3 py-2">{run.taskKey}</td>
                      <td className="px-3 py-2 text-text-muted">{run.agentName || "—"}</td>
                      <td
                        className={`px-3 py-2 ${endedBadly(run) ? "text-danger" : "text-success"}`}
                      >
                        {endState(run)}
                        {run.detail && (
                          <span
                            data-testid="run-detail"
                            className="mt-0.5 block max-h-24 overflow-auto whitespace-pre-wrap break-words text-xs font-normal text-text-muted"
                          >
                            {run.detail}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-text-muted">{run.minutes} min</td>
                      <td className="px-3 py-2 text-right text-text-muted">
                        ${run.costUsd.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </SettingsCard>
    </div>
  );
}
