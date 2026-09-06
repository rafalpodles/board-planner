"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { useToast } from "@/components/ui/Toast";
import { timeAgo } from "@/lib/time";
import { endedBadly, endState } from "@/lib/run-outcome";
import { ApiFleetRun } from "@/types";

// A run's detail is the only durable account of why it ended the way it did — the gate's reason,
// the pull request it opened, the sentence the agent gave for handing the task back. The fleet page
// shows the phase of a run in flight and nothing at all once it is over; this is the other half.
export default function FleetRunsPage() {
  const api = useApi();
  const router = useRouter();
  const { isAdmin, isLoading: authLoading } = useAuth();
  const { toast } = useToast();

  const [runs, setRuns] = useState<ApiFleetRun[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setRuns(await api.get("/api/admin/runs"));
    } catch {
      toast("Failed to load the run history", "error");
      setFailed(true);
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
  }, [isAdmin, authLoading, router, load]);

  if (authLoading || (runs === null && !failed)) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }
  if (!isAdmin) return null;

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-6">
        <h2 className="text-lg font-semibold mb-1">Run history</h2>
        <p className="text-sm text-text-muted">
          Every run that has finished on this instance, newest first, with what it said on the way
          out. A project&apos;s own recent runs are on that project, under Workers.
        </p>
        <Link href="/settings/workers" className="mt-2 inline-block text-sm text-text-muted underline">
          Back to the fleet
        </Link>
      </div>

      {failed || runs === null ? (
        // Not the empty state: "nothing has finished yet" is a claim about every run on this
        // instance, and a read that never answered supports none
        <LoadFailed
          testId="fleet-runs-error"
          message="Failed to load the run history."
          onRetry={load}
        />
      ) : runs.length === 0 ? (
        <p className="text-sm text-text-muted">Nothing has finished yet.</p>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-bg-input text-text-muted text-xs border-b border-border">
                  <th className="text-left px-3 py-2 font-medium">Finished</th>
                  <th className="text-left px-3 py-2 font-medium">Task</th>
                  <th className="text-left px-3 py-2 font-medium">Project</th>
                  <th className="text-left px-3 py-2 font-medium">Agent</th>
                  <th className="text-left px-3 py-2 font-medium">Machine</th>
                  <th className="text-left px-3 py-2 font-medium">Ended</th>
                  <th className="text-right px-3 py-2 font-medium">Took</th>
                  <th className="text-right px-3 py-2 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => [
                  <tr key={run._id} className="border-b-0">
                    <td
                      className="px-3 py-2 text-text-muted whitespace-nowrap"
                      title={new Date(run.finishedAt).toLocaleString()}
                    >
                      {timeAgo(run.finishedAt)}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{run.taskKey}</td>
                    <td className="px-3 py-2 text-text-muted whitespace-nowrap">
                      {run.projectName || run.projectKey || "—"}
                    </td>
                    <td className="px-3 py-2 text-text-muted whitespace-nowrap">
                      {run.agentName || "—"}
                    </td>
                    {/* A run written before the machine reported itself, or by hand through the
                        API, has no worker — and a blank cell is the honest answer for it */}
                    <td className="px-3 py-2 text-text-muted whitespace-nowrap">
                      {run.workerName || "—"}
                    </td>
                    <td
                      className={`px-3 py-2 whitespace-nowrap ${
                        endedBadly(run) ? "text-danger" : "text-success"
                      }`}
                    >
                      {endState(run)}
                    </td>
                    <td className="px-3 py-2 text-right text-text-muted whitespace-nowrap">
                      {run.minutes} min
                    </td>
                    <td className="px-3 py-2 text-right text-text-muted whitespace-nowrap">
                      ${run.costUsd.toFixed(2)}
                    </td>
                  </tr>,
                  <tr key={`${run._id}-detail`} className="border-b border-border last:border-b-0">
                    <td colSpan={8} className="px-3 pb-3 pt-0">
                      {run.detail ? (
                        <p
                          data-testid="run-detail"
                          className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-bg-input px-2 py-1.5 text-xs text-text-muted"
                        >
                          {run.detail}
                        </p>
                      ) : (
                        <p data-testid="run-detail-empty" className="text-xs text-text-muted">
                          {/* A refusal puts its reason in the gate's name, so the empty detail on
                              one is expected rather than missing */}
                          {run.refusedBy
                            ? `The ${run.refusedBy} gate refused it and said nothing further.`
                            : "Nothing was recorded about how this run ended."}
                        </p>
                      )}
                    </td>
                  </tr>,
                ])}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
