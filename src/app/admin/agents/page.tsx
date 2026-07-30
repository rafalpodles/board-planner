"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { DEFAULT_PROJECT_ICON } from "@/types";
import { projectPath } from "@/lib/urls";

interface AgentRow {
  _id: string;
  key: string;
  name: string;
  icon?: string;
  enabled: boolean;
  lockedByInstance: boolean;
  model: string;
  dailyTurnCap: number;
  autonomy: {
    dailyReview: boolean;
    reviewIntervalHours: number;
    handleNeedsHumanReview: boolean;
  };
}

interface AgentsResponse {
  pmAvailable: boolean;
  defaults: { pmDefaultModel: string; pmDefaultDailyTurnCap: number; envModel: string };
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
  const [defaultModel, setDefaultModel] = useState("");
  const [defaultCap, setDefaultCap] = useState("0");
  const [savingDefaults, setSavingDefaults] = useState(false);

  const load = useCallback(async () => {
    try {
      const res: AgentsResponse = await api.get("/api/admin/agents");
      setData(res);
      setDefaultModel(res.defaults.pmDefaultModel);
      setDefaultCap(String(res.defaults.pmDefaultDailyTurnCap));
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
      setData((prev) =>
        prev
          ? {
              ...prev,
              projects: prev.projects.map((p) => (p._id === row._id ? { ...p, ...updated } : p)),
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

  async function saveDefaults() {
    const cap = Number(defaultCap);
    if (!Number.isInteger(cap) || cap < 0 || cap > 1000) {
      toast("Default turn cap must be a whole number between 0 and 1000", "error");
      return;
    }
    setSavingDefaults(true);
    try {
      await api.put("/api/settings", {
        pmDefaultModel: defaultModel.trim(),
        pmDefaultDailyTurnCap: cap,
      });
      toast("Instance defaults saved", "success");
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to save defaults", "error");
    } finally {
      setSavingDefaults(false);
    }
  }

  if (authLoading || loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }
  if (!isAdmin || !data) return null;

  const effectiveDefault = data.defaults.pmDefaultModel || data.defaults.envModel;

  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-1">PM agents</h1>
      <p className="text-sm text-text-muted mb-6">
        Every project on this instance. Only an instance admin can change what is on this page.
      </p>

      {!data.pmAvailable && (
        <div className="mb-6 flex gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          <span aria-hidden="true">⚠</span>
          <p>
            <strong className="font-semibold">No OpenRouter key is configured</strong>, so no agent can
            run regardless of the switches below.
          </p>
        </div>
      )}

      <section className="mb-8 rounded-xl border border-border bg-bg-card p-4">
        <h2 className="font-semibold mb-1">Instance defaults</h2>
        <p className="text-xs text-text-muted mb-4">
          Used by any project that leaves its own value blank. Without them the fallback is the{" "}
          <code className="font-mono">PM_MODEL</code> environment variable, which needs a redeploy to
          change.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Default model"
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
            placeholder={data.defaults.envModel}
          />
          <Input
            label="Default daily turn cap"
            type="number"
            value={defaultCap}
            onChange={(e) => setDefaultCap(e.target.value)}
            placeholder="0 = use the environment value"
          />
        </div>
        <div className="mt-3">
          <Button size="sm" onClick={saveDefaults} disabled={savingDefaults}>
            {savingDefaults ? "Saving..." : "Save defaults"}
          </Button>
        </div>
      </section>

      <div className="border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg-input text-text-muted text-xs border-b border-border">
                <th className="text-left px-3 py-2 font-medium">Project</th>
                <th className="text-left px-3 py-2 font-medium">Agent</th>
                <th className="text-left px-3 py-2 font-medium">Model</th>
                <th className="text-left px-3 py-2 font-medium w-28">Turn cap</th>
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
                        className={`text-xs px-2 py-1 rounded border transition-colors cursor-pointer ${
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
                    <Input
                      value={row.model}
                      onChange={(e) =>
                        setData((prev) =>
                          prev
                            ? {
                                ...prev,
                                projects: prev.projects.map((p) =>
                                  p._id === row._id ? { ...p, model: e.target.value } : p
                                ),
                              }
                            : prev
                        )
                      }
                      onBlur={(e) => {
                        if (e.target.value !== data.defaults.pmDefaultModel) {
                          patch(row, { model: e.target.value });
                        }
                      }}
                      placeholder={effectiveDefault}
                      className="text-xs"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      type="number"
                      value={String(row.dailyTurnCap)}
                      onChange={(e) =>
                        setData((prev) =>
                          prev
                            ? {
                                ...prev,
                                projects: prev.projects.map((p) =>
                                  p._id === row._id
                                    ? { ...p, dailyTurnCap: Number(e.target.value) || 0 }
                                    : p
                                ),
                              }
                            : prev
                        )
                      }
                      onBlur={(e) => patch(row, { dailyTurnCap: Number(e.target.value) || 0 })}
                      className="text-xs"
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
