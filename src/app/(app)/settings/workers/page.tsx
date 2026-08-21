"use client";

import Link from "next/link";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EnrolWorkerModal } from "@/components/settings/EnrolWorkerModal";
import { usePollWhileVisible } from "@/hooks/use-poll-while-visible";
import { timeAgo } from "@/lib/time";
import { workerPolicyRows } from "@/lib/worker-policy-view";
import { commandStatus, WorkerCommand } from "@/lib/worker-command-status";
import { ApiWorker, ApiWorkerPreflight } from "@/types";

const POLL_MS = 5_000;

const TONE_CLASSES = {
  pending: "text-warning",
  applied: "text-text-muted",
  warning: "text-danger",
};

// Whose machine this is, which since BP-358 is the whole of what it may reach: the projects that
// person can reach, resolved on every call. A worker with no owner reaches nothing at all, and
// looked identical to a healthy one until this column existed — it has no binding error, no failed
// heartbeat and an empty assignment list, which is also what an idle machine has.
function OwnerCell({
  worker,
  disabled,
  onRelease,
}: {
  worker: ApiWorker;
  disabled: boolean;
  onRelease: () => void;
}) {
  if (!worker.owner) {
    return (
      <span className="text-xs text-danger" data-testid="worker-no-owner">
        no owner — claims nothing
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span className="text-xs text-text" title={worker.owner.username}>
        {worker.owner.fullName || worker.owner.username}
      </span>
      {/* Registration refuses to re-register a machine that belongs to somebody else, so without a
          way to let one go, a machine whose owner has left could never be enrolled again under the
          same name and host. */}
      <button
        data-testid="worker-release"
        disabled={disabled}
        onClick={onRelease}
        title="Release it, so somebody else can enrol this machine"
        className="text-xs text-text-muted underline decoration-dotted hover:text-danger cursor-pointer"
      >
        release
      </button>
    </span>
  );
}

// A worker that has never reported this is not a worker that passed — showing it green would be the
// "healthy in the console, fails every task" this column exists to end.
function PreflightCell({ preflight }: { preflight: ApiWorkerPreflight | null }) {
  if (!preflight) return <span className="text-text-muted">not reported</span>;

  const failed = preflight.checks.filter((c) => !c.ok);
  const detail = preflight.checks.map((c) => `${c.ok ? "ok" : "FAILED"}  ${c.name} — ${c.detail}`).join("\n");

  if (failed.length === 0) {
    return (
      <span className="text-xs text-text-muted block truncate" title={detail}>
        ready{preflight.account ? ` · ${preflight.account}` : ""}
      </span>
    );
  }

  return (
    <span className="text-xs text-danger block truncate" title={detail}>
      {failed.map((c) => c.name).join(", ")} — {failed[0].detail}
    </span>
  );
}

export default function AdminWorkersPage() {
  const api = useApi();
  const router = useRouter();
  const { isAdmin, isLoading: authLoading } = useAuth();
  const { toast } = useToast();

  const [workers, setWorkers] = useState<ApiWorker[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  // The only way back from a release is a fresh enrolment run on that machine, by whoever sits at
  // it — every other destructive control in this product asks first, and this one is less reversible
  // than most of them.
  const [releasing, setReleasing] = useState<ApiWorker | null>(null);

  const load = useCallback(async () => {
    try {
      const res: ApiWorker[] = await api.get("/api/admin/workers");
      setWorkers(res);
    } catch {
      toast("Failed to load workers", "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin) router.replace("/projects");
  }, [isAdmin, authLoading, router]);

  usePollWhileVisible(load, POLL_MS, !authLoading && isAdmin);

  async function patch(
    worker: ApiWorker,
    changes: Partial<Pick<ApiWorker, "enabled" | "lockedByInstance" | "owner">>
  ) {
    setSavingId(worker._id);
    try {
      const updated = await api.patch(`/api/workers/${worker._id}`, changes);
      setWorkers((prev) => (prev ? prev.map((w) => (w._id === worker._id ? { ...w, ...updated } : w)) : prev));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Update failed", "error");
      load();
    } finally {
      setSavingId(null);
    }
  }

  async function sendCommand(worker: ApiWorker, command: WorkerCommand) {
    setSavingId(worker._id);
    try {
      const res: { command: WorkerCommand; issuedAt: string } = await api.post(
        `/api/workers/${worker._id}/command`,
        { command }
      );
      setWorkers((prev) =>
        prev
          ? prev.map((w) =>
              w._id === worker._id
                ? { ...w, command: res.command, commandIssuedAt: res.issuedAt, commandAckedAt: null }
                : w
            )
          : prev
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : "Command failed", "error");
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
  if (!isAdmin || !workers) return null;

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h2 className="text-lg font-semibold mb-1">Worker fleet</h2>
          <p className="text-sm text-text-muted">
            Every worker registered on this instance. Only an instance admin can change what is on this page.
          </p>
        </div>
        <Button onClick={() => setEnrolling(true)}>Enrol a worker</Button>
      </div>

      <EnrolWorkerModal open={enrolling} onClose={() => setEnrolling(false)} />

      <ConfirmDialog
        open={!!releasing}
        onClose={() => setReleasing(null)}
        title={`Release ${releasing?.name ?? ""}?`}
        message={`${releasing?.owner?.fullName || releasing?.owner?.username || "Its owner"} will stop being the owner of this machine, and it will claim nothing until somebody enrols it again — which has to be done from the machine itself, by whoever sits at it. Nothing here can undo it.`}
        confirmLabel="Release"
        loading={savingId === releasing?._id}
        onConfirm={() => {
          const worker = releasing;
          setReleasing(null);
          if (worker) patch(worker, { owner: null });
        }}
      />

      <div className="border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg-input text-text-muted text-xs border-b border-border">
                <th className="text-left px-3 py-2 font-medium">Name</th>
                <th className="text-left px-3 py-2 font-medium">Host</th>
                <th className="text-left px-3 py-2 font-medium">Version</th>
                <th className="text-left px-3 py-2 font-medium">Checkouts</th>
                <th className="text-left px-3 py-2 font-medium">Owner</th>
                <th className="text-left px-3 py-2 font-medium">Running</th>
                <th className="text-left px-3 py-2 font-medium">Last seen</th>
                <th className="text-left px-3 py-2 font-medium">Preflight</th>
                <th className="text-left px-3 py-2 font-medium">Binding error</th>
                <th className="text-left px-3 py-2 font-medium">Enabled</th>
                <th className="text-left px-3 py-2 font-medium">Lock</th>
                <th className="text-left px-3 py-2 font-medium">Commands</th>
              </tr>
            </thead>
            <tbody>
              {workers.length === 0 && (
                <tr>
                  <td colSpan={12} className="px-3 py-6 text-center text-text-muted text-sm">
                    No workers registered yet.
                  </td>
                </tr>
              )}
              {workers.map((worker) => {
                const status = commandStatus(worker);
                return [
                  <tr key={worker._id} className="border-b-0">
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{worker.name}</td>
                    <td className="px-3 py-2 text-text-muted whitespace-nowrap">{worker.host || "—"}</td>
                    <td className="px-3 py-2 text-text-muted font-mono text-xs whitespace-nowrap">
                      {worker.version || "—"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {/* The count was the whole answer here, and the question it left was "so how
                          do I give it another one" — which had no answer on any screen. */}
                      <Link
                        href={`/settings/workers/${worker._id}/projects`}
                        className="text-sm text-text-muted underline"
                        title={(worker.repos ?? []).map((r) => `${r.remote} → ${r.path}`).join("\n")}
                      >
                        {worker.repos?.length
                          ? `${worker.repos.length} repo${worker.repos.length === 1 ? "" : "s"}`
                          : "none reported"}
                      </Link>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {worker.currentTask ? (
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs">{worker.currentTask.taskKey}</span>
                          <span className="text-text-muted text-xs">
                            {worker.currentTask.phase ?? "starting"}
                          </span>
                          {worker.currentTask.phaseAt && (
                            <span className="text-text-muted text-xs">
                              {timeAgo(worker.currentTask.phaseAt)}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span className={worker.stale ? "text-danger" : "text-text-muted"}>
                          {worker.lastSeenAt ? timeAgo(worker.lastSeenAt) : "never"}
                        </span>
                        {worker.stale && (
                          <span className="text-xs px-1.5 py-0.5 rounded-full border border-danger/40 bg-danger/10 text-danger">
                            stale
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 max-w-[12rem]">
                      <OwnerCell
                        worker={worker}
                        disabled={savingId === worker._id}
                        onRelease={() => setReleasing(worker)}
                      />
                    </td>
                    <td className="px-3 py-2 max-w-[14rem]">
                      <PreflightCell preflight={worker.preflight} />
                    </td>
                    <td className="px-3 py-2 max-w-[16rem]">
                      {worker.bindingError && (
                        <span className="text-xs text-danger block truncate" title={worker.bindingError}>
                          {worker.bindingError}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Button
                        size="sm"
                        variant={worker.enabled && !worker.lockedByInstance ? "primary" : "secondary"}
                        disabled={savingId === worker._id || worker.lockedByInstance}
                        onClick={() => patch(worker, { enabled: !worker.enabled })}
                      >
                        {worker.enabled ? "On" : "Off"}
                      </Button>
                    </td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => patch(worker, { lockedByInstance: !worker.lockedByInstance })}
                        disabled={savingId === worker._id}
                        className={`text-xs px-2 py-1 rounded border transition-colors cursor-pointer ${
                          worker.lockedByInstance
                            ? "border-danger bg-danger/10 text-danger"
                            : "border-border text-text-muted hover:text-text"
                        }`}
                        title={
                          worker.lockedByInstance
                            ? "Locked — this worker cannot claim or continue tasks"
                            : "Lock this worker (kill switch)"
                        }
                      >
                        {worker.lockedByInstance ? "Locked" : "Lock"}
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-1">
                        {status && (
                          <span className={`text-xs ${TONE_CLASSES[status.tone]}`}>{status.text}</span>
                        )}
                        <div className="flex flex-wrap gap-1">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={savingId === worker._id}
                            onClick={() => sendCommand(worker, "pause")}
                          >
                            Pause
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={savingId === worker._id}
                            onClick={() => sendCommand(worker, "resume")}
                          >
                            Resume
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={savingId === worker._id}
                            onClick={() => sendCommand(worker, "stop")}
                          >
                            Stop
                          </Button>
                        </div>
                      </div>
                    </td>
                  </tr>,
                  <tr key={`${worker._id}-policy`} className="border-b border-border last:border-b-0">
                    <td colSpan={12} className="px-3 pb-3 pt-0">
                      <div className="flex flex-wrap gap-1.5">
                        {workerPolicyRows(worker as never).map((row) => (
                          <span
                            key={row.field}
                            title={
                              row.overridden
                                ? `Set on this worker. Default is ${row.defaultValue}.`
                                : `Inherited. Changing the default moves this worker too.`
                            }
                            className={
                              row.overridden
                                ? "inline-flex items-center gap-1 rounded border border-border bg-bg-input px-1.5 py-0.5 text-xs"
                                : "inline-flex items-center gap-1 rounded border border-transparent px-1.5 py-0.5 text-xs text-text-muted"
                            }
                          >
                            <span className="font-mono">{row.field}</span>
                            <span className={row.overridden ? "font-medium" : ""}>{row.value}</span>
                            <span className="text-text-muted">
                              {row.overridden ? "set" : "default"}
                            </span>
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>,
                ];
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
