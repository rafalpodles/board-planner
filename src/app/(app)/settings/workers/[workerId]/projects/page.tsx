"use client";

import { LIST_REFRESH_FAILED } from "@/lib/list-refresh";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/shell/PageHeader";

// Where somebody says which projects a machine works on. A browser screen and not a pane in the
// menubar app, for a reason that is not a preference: ticking a project may mean switching workers
// on for it, and that is an instance admin in an interactive session — which the app, holding only
// the machine's own credential, can never be.

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
  /** Kept apart from `error`: one says the save did not happen, the other that the list is old */
  const [stale, setStale] = useState("");

  useEffect(() => {
    // `picked` is the reader's, and this seeds it. Without the flag a second run of the effect —
    // which Strict Mode does on every mount in development — answers after the reader has ticked
    // a row and puts the server's set back, discarding the tick. The save that follows then sends
    // the old set, and the screen shows no sign of it (BP-553).
    let ignore = false;
    api
      .get(`/api/workers/${workerId}/projects`)
      .then((data: View) => {
        if (ignore) return;
        setView(data);
        setPicked(new Set(data.catalogue.filter((row) => row.wanted).map((row) => row.project)));
      })
      // A failed load has to say so. Left to a `finally` alone this renders as a spinner nobody
      // can get out of, which is the same screen as a server that is simply slow.
      .catch((e: Error) => {
        if (!ignore) setError(e.message || "Could not load this machine's projects");
      });
    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerId]);

  function toggle(row: CatalogueRow) {
    setSaved("");
    setError("");
    setStale("");
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
    setStale("");
    let left: string[];
    try {
      const result = await api.put(`/api/workers/${workerId}/projects`, {
        projects: [...picked],
      });
      left = (result?.leftDisabled ?? []) as string[];
      setSaved(
        left.length
          ? `Saved. ${left.join(", ")} ${left.length === 1 ? "does not run machines" : "do not run machines"} yet, and only an instance admin can turn that on — the machine will leave ${left.length === 1 ? "it" : "them"} alone until somebody does.`
          : "Saved. The app picks this up the next time it connects to the worker."
      );
    } catch (e) {
      setSaved("");
      setError((e as Error).message || "Could not save");
      setSaving(false);
      return;
    }
    // The rows carry what the write did, so a failed re-read does not leave them describing the
    // board as it was — the pending-delete warning outliving the removal it warned about.
    //
    // Downward only. `servedHere` is what the *machine* reported having, and the write records a
    // wish rather than a clone: setting it upward would paint a checkout that does not exist yet
    // and swallow the line saying one is coming. `workersEnabled` is different — the write really
    // does throw that switch, for everything the response did not list as left off.
    setView((prev) =>
      prev
        ? {
            ...prev,
            catalogue: prev.catalogue.map((row) => ({
              ...row,
              servedHere: row.servedHere && picked.has(row.project),
              workersEnabled:
                row.workersEnabled || (picked.has(row.project) && !left.includes(row.key)),
            })),
          }
        : prev
    );
    // A second fact, and a different one: the save landed, so saying "Could not save" here would
    // deny something that happened. All that is wrong is what somebody else may have changed
    try {
      setView(await api.get(`/api/workers/${workerId}/projects`));
    } catch {
      setStale(LIST_REFRESH_FAILED);
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
        Tick a project and this machine sets up a checkout for it. Untick one and the app offers to
        remove the checkout, asking on the machine first.
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

      {/* Named by project here and by path on the machine. This screen never learns a path — the
          socket carries none — and the one the server could infer from a heartbeat is matched by a
          looser rule than the one the app deletes by, so naming it here could name the wrong
          directory. Worse than naming none. */}
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
            Saving does not delete anything. The app asks on the machine first, naming every
            directory it is about to remove, and refuses any checkout with uncommitted changes,
            unpushed commits, or a task running in it.
          </p>
        </div>
      )}

      {adding.length > 0 && (
        <p className="mt-4 text-sm text-text-muted">
          {adding.length === 1 ? "One project" : `${adding.length} projects`} will be cloned by the
          app the next time it connects to the worker.
        </p>
      )}

      {/* The outcome of the click first, then the caveat. And a warning rather than a danger:
          on this page red is what "your action did not happen" looks like */}
      {saved && <p className="mt-4 text-sm text-text-muted">{saved}</p>}
      {stale && <p className="mt-4 text-sm text-warning">{stale}</p>}
      {error && <p className="mt-4 text-sm text-danger">{error}</p>}

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
