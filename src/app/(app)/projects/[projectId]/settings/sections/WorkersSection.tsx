"use client";

import { useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useDraft } from "@/hooks/use-draft";
import { useToast } from "@/components/ui/Toast";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { useDirtyGroup } from "@/components/settings/settings-context";
import { CLAIM_SCOPES, ClaimScope, PROJECT_POLICY_DEFAULTS } from "@/lib/worker-policy";
import { projectRemotes, sameRepo } from "@/lib/repo-match";
import { ApiProject, ApiUserSummary, ApiWorker } from "@/types";
import { SectionProps } from "./types";
import { AgentRunOutcome, ApiAgentRun } from "@/types";

const OUTCOME_LABELS: Record<AgentRunOutcome, string> = {
  delivered: "Pull request open",
  merged: "Merged",
  refused: "Refused",
  blocked: "Went to a human",
  failed: "Failed",
  requeued: "Back in the queue",
  released: "Released",
};

const FAILED_OUTCOMES = new Set<AgentRunOutcome>(["refused", "blocked", "failed"]);
import Link from "next/link";
import { useStore } from "@/app/(app)/agents/store";

const NUMBER_FIELDS = new Set(["taskTimeoutMs", "runCeilingMs", "maxDiffLines", "maxDiffFiles"]);
const LABELS: Record<string, string> = {
  autoMerge: "Merge automatically",
  reviewGate: "Review the diff before delivering",
  claimScope: "Tasks a worker may take",
  baseBranch: "Base branch",
  taskTimeoutMs: "Timeout for one step (ms)",
  runCeilingMs: "Timeout for the whole run (ms)",
  maxDiffLines: "Largest diff (lines)",
  maxDiffFiles: "Largest diff (files)",
  model: "Model",
  fallbackModel: "Fallback model",
  reviewModel: "Review model",
};

const CLAIM_SCOPE_LABELS: Record<ClaimScope, string> = {
  assigned: "Only tasks assigned to the worker",
  any: "Any unassigned task in the column",
};

type PolicyValue = string | number | boolean;
type Draft = Record<string, PolicyValue>;

// Moved onto the block that does the thing: size thresholds are the Size gate's, review is the
// Reviewed gate's presence and parameters, and the models belong to the step that calls them.
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

// An inherited field shows the default rather than the stored copy of it: the two diverge once a
// default changes, and the default is what a worker will actually run under.
function draftFrom(project: ApiProject): Draft {
  const stored = (project.worker?.policy ?? {}) as unknown as Record<string, PolicyValue>;
  const pinned = new Set(project.worker?.policyOverrides ?? []);
  const draft: Draft = {
    enabled: !!project.worker?.enabled,
    claimAssignee: project.worker?.claimAssignee ?? "",
  };
  for (const field of FIELDS) draft[field] = pinned.has(field) ? stored[field] : DEFAULTS[field];
  return draft;
}

export function WorkersSection({ projectId, project, replaceProject, isAdmin }: SectionProps) {
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
    } catch {
      setDefaultAgent(previous);
    }
  };
  const api = useApi();
  const { toast } = useToast();

  const [workers, setWorkers] = useState<ApiWorker[] | null>(null);
  const [people, setPeople] = useState<ApiUserSummary[]>([]);
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
    api
      .get("/api/users/list")
      .then(setPeople)
      .catch(() => setPeople([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  async function save(): Promise<void> {
    const policy: Record<string, PolicyValue> = {};
    for (const field of draft.dirtyKeys) {
      const name = String(field);
      if (name === "enabled" || name === "claimAssignee" || unpinned.has(name)) continue;
      policy[name] = draft.value[name];
    }

    const patch: Record<string, unknown> = {};
    if (draft.isDirty("enabled")) patch.enabled = draft.value.enabled;
    if (draft.isDirty("claimAssignee")) patch.claimAssignee = draft.value.claimAssignee || null;
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
              // Reads the scope in the draft, not the stored one: the sentence has to describe what
              // saving would do, or enabling and narrowing in one visit is described backwards
              hint={
                draft.value.claimScope === "any"
                  ? "Any unassigned task in an approved column is picked up by a machine offering this repository."
                  : "Only tasks handed over below are picked up. Nothing else is touched."
              }
            />

            <div className="mt-4">
              <p className="text-sm font-medium mb-2">Hand tasks over to</p>
              <select
                value={String(draft.value.claimAssignee ?? "")}
                disabled={!isAdmin}
                onChange={(e) => draft.set("claimAssignee", e.target.value)}
                className="focus-ring w-full rounded-lg border border-border bg-bg-input px-2 py-1.5 text-sm"
              >
                <option value="">Nobody yet</option>
                {people.map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.fullName ? `${p.fullName} (${p.username})` : p.username}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-text-muted">
                {draft.value.claimScope === "any"
                  ? "Assigning a task to this person offers it to a worker. Unassigned tasks are offered too."
                  : !draft.value.claimAssignee
                    ? "Until you pick somebody, nothing qualifies and no work is picked up."
                    : "A worker takes only tasks assigned to this person. Assigning one is how you hand work over."}
              </p>
            </div>

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
            // What the row will mean once saved, not what is stored right now
            const inherits = unpinned.has(field) || (!pinned.has(field) && !draft.isDirty(field));
            return (
              <div key={field} className="flex items-center gap-3">
                {/* A boolean carries its own label, so the shared one would say it twice */}
                {typeof value !== "boolean" && (
                  <span className="w-52 text-sm">{LABELS[field] ?? field}</span>
                )}
                {typeof value === "boolean" ? (
                  <Switch
                    checked={value}
                    disabled={!isAdmin}
                    onChange={(v) => editField(field, v)}
                    label={LABELS[field] ?? field}
                  />
                ) : field === "claimScope" ? (
                  // A closed set, so a text box would only offer new ways to be wrong — and a
                  // rejected typo here reads as a worker that has stopped picking work up
                  <select
                    value={String(value)}
                    disabled={!isAdmin}
                    onChange={(e) => editField(field, e.target.value)}
                    className="focus-ring flex-1 rounded-lg border border-border bg-bg-input px-2 py-1.5 text-sm"
                  >
                    {CLAIM_SCOPES.map((scope) => (
                      <option key={scope} value={scope}>
                        {CLAIM_SCOPE_LABELS[scope]}
                      </option>
                    ))}
                  </select>
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

      <SettingsCard
        title="Agent"
        description="How a worker carries a task on this project. Pick a different one on a single task when it needs it."
      >
        <div className="max-w-md">
          <p className="text-sm font-medium mb-2">Default agent</p>
          <select
            value={defaultAgent}
            disabled={!isAdmin || store.loading}
            onChange={(e) => saveDefaultAgent(e.target.value)}
            className="w-full rounded-lg border border-border bg-bg-input px-2 py-1.5 text-sm"
          >
            {store.allAgents
              .filter((a) => a.scope !== "user")
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
                        className={`px-3 py-2 ${
                          FAILED_OUTCOMES.has(run.outcome) ? "text-danger" : "text-success"
                        }`}
                      >
                        {run.refusedBy ? `Refused: ${run.refusedBy}` : OUTCOME_LABELS[run.outcome]}
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
