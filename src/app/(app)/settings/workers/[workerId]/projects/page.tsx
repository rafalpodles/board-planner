"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/shell/PageHeader";

interface CatalogueRow {
  project: string;
  key: string;
  name: string;
  repositoryUrl: string;
  available: boolean;
  workersEnabled: boolean;
  servedHere: boolean;
  wanted: boolean;
}

interface View {
  worker: { _id: string; name: string; host: string };
  canEnableWorkers: boolean;
  catalogue: CatalogueRow[];
}

export default function MachineProjectsPage() {
  const params = useParams();
  const workerId = String(params.workerId ?? "");
  const api = useApi();

  const [view, setView] = useState<View | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    api
      .get(`/api/workers/${workerId}/projects`)
      .then((data: View) => {
        setView(data);
        setPicked(new Set(data.catalogue.filter((row) => row.wanted).map((row) => row.project)));
      })
      .catch((e: Error) => setError(e.message || "Could not load this machine's projects"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerId]);

  function toggle(row: CatalogueRow) {
    setSaved("");
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(row.project)) next.delete(row.project);
      else next.add(row.project);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const result = await api.put(`/api/workers/${workerId}/projects`, {
        projects: [...picked],
      });
      const left = (result?.leftDisabled ?? []) as string[];
      setSaved(
        left.length
          ? `Saved. ${left.join(", ")} ${left.length === 1 ? "does not run machines" : "do not run machines"} yet, and only an instance admin can turn that on — the machine will leave ${left.length === 1 ? "it" : "them"} alone until somebody does.`
          : "Saved. The app picks this up and sets up the checkouts."
      );
      const data: View = await api.get(`/api/workers/${workerId}/projects`);
      setView(data);
    } catch (e) {
      setError((e as Error).message || "Could not save");
    } finally {
      setSaving(false);
    }
  }

  if (error && !view) {
    return (
      <div className="p-6">
        <p className="text-danger">{error}</p>
      </div>
    );
  }
  if (!view) return <div className="p-6 text-text-muted">Loading…</div>;

  const removing = view.catalogue.filter((row) => row.servedHere && !picked.has(row.project));
  const adding = view.catalogue.filter((row) => !row.servedHere && picked.has(row.project));

  return (
    <div className="max-w-2xl p-6">
      <PageHeader
        title={`Projects for ${view.worker.name}`}
        subtitle={view.worker.host || undefined}
      />
      <p className="mt-2 text-text-muted">
        Tick a project and this machine sets up a checkout for it. Untick one and the checkout is
        removed from the machine.
      </p>

      <div className="mt-6 space-y-2">
        {view.catalogue.length === 0 && (
          <p className="text-sm text-text-muted">
            You cannot reach any project yet, so there is nothing to give this machine.
          </p>
        )}

        {view.catalogue.map((row) => (
          <label
            key={row.project}
            className={`flex items-start gap-3 rounded-lg border border-border p-3 ${
              row.available ? "cursor-pointer hover:border-primary" : "opacity-60"
            }`}
          >
            <input
              type="checkbox"
              className="mt-1"
              checked={picked.has(row.project)}
              disabled={!row.available}
              onChange={() => toggle(row)}
            />
            <span className="min-w-0">
              <span className="block font-medium text-text">
                {row.name} <span className="text-text-muted">· {row.key}</span>
                {row.servedHere && (
                  <span className="ml-2 text-xs text-text-muted">connected</span>
                )}
              </span>
              <span className="block truncate font-mono text-xs text-text-muted">
                {row.repositoryUrl || "no repository set — add one under the project's Integrations settings"}
              </span>
              {row.available && !row.workersEnabled && (
                <span className="block text-xs text-warning">
                  {view.canEnableWorkers
                    ? "does not run machines yet — ticking it turns that on"
                    : "does not run machines yet, and only an instance admin can turn that on"}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>

      {removing.length > 0 && (
        <div className="mt-6 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-text">
          <p className="font-medium">Saving removes {removing.length === 1 ? "a checkout" : "checkouts"} from this machine:</p>
          <ul className="mt-2 list-disc pl-5">
            {removing.map((row) => (
              <li key={row.project}>
                {row.name} · {row.key}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-text-muted">
            The app does the removing, and refuses any checkout with uncommitted changes, unpushed
            commits, or a task running in it. It names the directory before it deletes anything.
          </p>
        </div>
      )}

      {adding.length > 0 && (
        <p className="mt-4 text-sm text-text-muted">
          {adding.length === 1 ? "One project" : `${adding.length} projects`} will be cloned by the
          app the next time it looks — which is right after you save.
        </p>
      )}

      {error && <p className="mt-4 text-sm text-danger">{error}</p>}
      {saved && <p className="mt-4 text-sm text-text-muted">{saved}</p>}

      <div className="mt-6 flex items-center gap-3">
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Link href="/settings/workers" className="text-sm text-text-muted underline">
          Back to machines
        </Link>
      </div>
    </div>
  );
}
