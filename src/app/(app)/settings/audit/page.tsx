"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/components/ui/Toast";
import { ApiInstanceAuditLog } from "@/types";

// Past tense, because every row is something that already happened. The identifiers are readable
// enough to fall back on, but "worker_locked" is not a sentence.
const LABELS: Record<string, string> = {
  worker_locked: "Kill switch on",
  worker_unlocked: "Kill switch cleared",
  worker_enabled: "Worker enabled",
  worker_disabled: "Worker disabled",
  worker_renamed: "Worker renamed",
  worker_poll_interval_changed: "Poll interval changed",
  enrolment_token_minted: "Enrolment token minted",
  enrolment_token_spent: "Enrolment token spent",
  project_workers_enabled: "Workers enabled for project",
  project_workers_disabled: "Workers disabled for project",
  user_password_reset: "Password set by an admin",
  user_email_changed: "Address changed by an admin",
};

// The actions worth spotting at a glance: one stops a machine, one hands out the credential that
// lets a new one join, and one hands somebody a way into another person's account.
const NOTABLE = new Set([
  "worker_locked",
  "enrolment_token_minted",
  "enrolment_token_spent",
  "user_password_reset",
  "user_email_changed",
]);

export default function InstanceAuditPage() {
  const api = useApi();
  const router = useRouter();
  const { isAdmin, isLoading: authLoading } = useAuth();
  const { toast } = useToast();

  const [logs, setLogs] = useState<ApiInstanceAuditLog[] | null>(null);

  const load = useCallback(async () => {
    try {
      setLogs(await api.get("/api/admin/audit"));
    } catch {
      toast("Failed to load the audit log", "error");
      setLogs([]);
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

  if (authLoading || logs === null) {
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
        <h2 className="text-lg font-semibold mb-1">Instance audit log</h2>
        <p className="text-sm text-text-muted">
          Instance-wide actions: stopping a machine, enrolling one, committing a project to
          workers, and setting somebody else&apos;s password or address. Each project keeps its own
          log of its own settings, under that project.
        </p>
      </div>

      {logs.length === 0 ? (
        <p className="text-sm text-text-muted">Nothing recorded yet.</p>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <tbody>
              {logs.map((log) => (
                <tr key={log._id} className="border-b border-border/50 last:border-b-0">
                  <td className="whitespace-nowrap py-2 px-3 align-top text-text-muted">
                    {new Date(log.createdAt).toLocaleString()}
                  </td>
                  {/* "system" for a machine, matching the project log — a worker spending its
                      enrolment token has no session to attribute the row to */}
                  <td className="whitespace-nowrap py-2 px-3 align-top font-medium">
                    {log.user?.username ?? "system"}
                  </td>
                  <td
                    className={`whitespace-nowrap py-2 px-3 align-top ${
                      NOTABLE.has(log.action) ? "text-danger" : "text-text-muted"
                    }`}
                  >
                    {LABELS[log.action] ?? log.action.replace(/_/g, " ")}
                  </td>
                  <td className="whitespace-nowrap py-2 px-3 align-top">{log.target}</td>
                  {/* w-full + max-w-0 is what lets a cell truncate instead of pushing the table
                      past its container */}
                  <td
                    className="w-full max-w-0 truncate py-2 px-3 align-top text-text-muted"
                    title={log.detail || undefined}
                  >
                    {log.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
