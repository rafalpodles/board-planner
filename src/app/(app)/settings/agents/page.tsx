"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { ModelPicker, type ModelCatalogue } from "@/components/settings/ModelPicker";
import { DEFAULT_PROJECT_ICON } from "@/types";
import { projectPath } from "@/lib/urls";
import { openrouterModel } from "@/lib/managed-models";

interface AgentRow {
  _id: string;
  key: string;
  name: string;
  icon?: string;
  enabled: boolean;
  lockedByInstance: boolean;
  model: string;
  autonomy: {
    dailyReview: boolean;
    reviewIntervalHours: number;
    handleNeedsHumanReview: boolean;
  };
}

interface AgentsResponse {
  pmAvailable: boolean;
  pmNeedsPlan?: boolean;
  pmKeyUnreadable?: boolean;
  pmLocked?: boolean;
  defaults: { aiModel: string };
  projects: AgentRow[];
}

export default function AdminAgentsPage() {
  const api = useApi();
  const router = useRouter();
  const { isAdmin, isLoading: authLoading } = useAuth();
  const { toast } = useToast();

  const [data, setData] = useState<AgentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null);
  const savedModels = useRef<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [res, models]: [AgentsResponse, ModelCatalogue] = await Promise.all([
        api.get("/api/admin/agents"),
        // Without the list the field takes a typed name, and the server still judges it
        api.get("/api/settings/ai-models").catch(() => ({ restricted: false, model: "", models: null, providers: null })),
      ]);
      setData(res);
      setCatalogue(models);
      savedModels.current = Object.fromEntries(res.projects.map((p) => [p._id, p.model]));
    } catch {
      toast("Failed to load agents", "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin) {
      router.replace("/projects");
      return;
    }
    load();
  }, [isAdmin, authLoading, load, router]);

  async function patch(row: AgentRow, changes: Partial<AgentRow>) {
    setSavingId(row._id);
    try {
      const updated = await api.patch(`/api/admin/agents/${row._id}`, changes);
      // Only the fields this request changed: the answer also carries the row's other fields as
      // they were stored when it left, and taking those overwrote a field typed into meanwhile
      const answer = updated as Record<string, unknown>;
      const confirmed = Object.fromEntries(
        Object.keys(changes)
          .filter((field) => field in answer)
          .map((field) => [field, answer[field]])
      );
      if (typeof confirmed.model === "string") savedModels.current[row._id] = confirmed.model;
      setData((prev) =>
        prev
          ? {
              ...prev,
              projects: prev.projects.map((p) => (p._id === row._id ? { ...p, ...confirmed } : p)),
            }
          : prev
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : "Update failed", "error");
      load();
    } finally {
      setSavingId(null);
    }
  }

  if (authLoading || loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }
  if (!isAdmin || !data || !catalogue) return null;

  return (
    <div className="w-full max-w-5xl mx-auto">
      <h2 className="text-lg font-semibold mb-1">PM agents</h2>
      <p className="text-sm text-text-muted mb-6">
        Every project on this instance. Only an instance admin can change what is on this page.
      </p>

      {!data.pmAvailable && (
        <div className="mb-6 flex gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          <span aria-hidden="true">⚠</span>
          {data.pmKeyUnreadable ? (
            <p>
              <strong className="font-semibold">No agent can run</strong>: the stored OpenRouter key cannot be read.{" "}
              <Link href="/settings/ai-keys" className="underline">
                Enter it again
              </Link>
              .
            </p>
          ) : data.pmLocked ? (
            <p>
              <strong className="font-semibold">No agent can run</strong>: the operator has switched its AI key off for this
              organisation.{" "}
              <Link href="/settings/ai-keys" className="underline">
                Add your own key
              </Link>{" "}
              to keep going.
            </p>
          ) : data.pmNeedsPlan ? (
            <p>
              <strong className="font-semibold">No agent can run</strong>: on the Free plan the PM agent needs your
              own OpenRouter key.{" "}
              <Link href="/settings/ai-keys" className="underline">
                Add a key
              </Link>
              , or{" "}
              <Link href="/settings/organisation" className="underline">
                upgrade to Pro
              </Link>{" "}
              and use ours.
            </p>
          ) : (
            <p>
              <strong className="font-semibold">No OpenRouter key is configured</strong>, so no agent can
              run regardless of the switches below.{" "}
              <Link href="/settings/ai-keys" className="underline">
                Add one here
              </Link>
              .
            </p>
          )}
        </div>
      )}

      <p className="mb-6 text-sm text-text-muted" data-testid="ai-model-moved">
        The model for the PM agent and for drafting a task with AI is set next to the key:{" "}
        <Link href="/settings/ai-keys" className="underline">
          Settings → AI key
        </Link>
        . A project can name its own PM model in the table below; AI task drafting always uses the one default.
      </p>

      <div className="border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg-input text-text-muted text-xs border-b border-border">
                <th className="text-left px-3 py-2 font-medium">Project</th>
                <th className="text-left px-3 py-2 font-medium">Agent</th>
                <th className="text-left px-3 py-2 font-medium">Model</th>
                <th className="text-left px-3 py-2 font-medium">Autonomy</th>
              </tr>
            </thead>
            <tbody>
              {data.projects.map((row) => (
                <tr key={row._id} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-2">
                    <Link href={projectPath(row.key)} className="hover:underline flex items-center gap-2">
                      <span aria-hidden="true">{row.icon || DEFAULT_PROJECT_ICON}</span>
                      <span className="font-mono text-xs bg-bg-input px-1.5 py-0.5 rounded">{row.key}</span>
                      <span className="truncate">{row.name}</span>
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant={row.enabled && !row.lockedByInstance ? "primary" : "secondary"}
                        disabled={savingId === row._id || row.lockedByInstance}
                        onClick={() => patch(row, { enabled: !row.enabled })}
                      >
                        {row.enabled ? "On" : "Off"}
                      </Button>
                      <button
                        onClick={() => patch(row, { lockedByInstance: !row.lockedByInstance })}
                        disabled={savingId === row._id}
                        className={`inline-flex min-h-11 cursor-pointer items-center rounded border px-3 text-xs transition-colors sm:min-h-0 sm:px-2 sm:py-1 ${
                          row.lockedByInstance
                            ? "border-danger bg-danger/10 text-danger"
                            : "border-border text-text-muted hover:text-text"
                        }`}
                        title={
                          row.lockedByInstance
                            ? "Locked off — the project cannot turn this agent on"
                            : "Lock this agent off for the project"
                        }
                      >
                        {row.lockedByInstance ? "Locked" : "Lock"}
                      </button>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <ModelPicker
                      ariaLabel={`PM model for ${row.key} — ${row.name}`}
                      value={row.model}
                      catalogue={catalogue}
                      emptyLabel={`Default — ${openrouterModel(data.defaults.aiModel)}`}
                      placeholder={openrouterModel(data.defaults.aiModel)}
                      className="text-xs"
                      onChange={(model) =>
                        setData((prev) =>
                          prev
                            ? {
                                ...prev,
                                projects: prev.projects.map((p) => (p._id === row._id ? { ...p, model } : p)),
                              }
                            : prev
                        )
                      }
                      onCommit={(model) => {
                        if (model !== savedModels.current[row._id]) patch(row, { model });
                      }}
                    />
                  </td>
                  <td className="px-3 py-2 text-xs text-text-muted whitespace-nowrap">
                    {row.autonomy.dailyReview
                      ? `Reviews every ${row.autonomy.reviewIntervalHours}h`
                      : "Manual only"}
                    {row.autonomy.handleNeedsHumanReview && " · handles review queue"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
