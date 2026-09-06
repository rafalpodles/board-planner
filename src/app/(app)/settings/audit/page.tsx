"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/components/ui/Toast";
import { ApiInstanceAuditLog } from "@/types";
import { auditActionLabel, auditActor, auditIsNotable } from "@/lib/instance-audit-view";

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
          workers, an account created, made an administrator or deleted, and anything that changes
          how an account is signed into — a password set for somebody, a reset by email, or an
          address moved, whether by an administrator or by the account itself. Each project keeps
          its own log of its own settings, under that project.
        </p>
      </div>

      {logs.length === 0 ? (
        <p className="text-sm text-text-muted">Nothing recorded yet.</p>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <tbody>
              {/* Five columns, four of them nowrap, inside an overflow-hidden card: on a phone
                  every row was sliced mid-word with nothing to scroll. Below sm the row is a
                  wrapping block instead, and only the table shape is kept for wider screens. */}
              {logs.map((log) => (
                <tr
                  key={log._id}
                  className="flex flex-wrap gap-x-2 border-b border-border/50 px-3 py-2 last:border-b-0 sm:table-row sm:px-0 sm:py-0"
                >
                  <td className="align-top text-text-muted sm:table-cell sm:whitespace-nowrap sm:px-3 sm:py-2">
                    {new Date(log.createdAt).toLocaleString()}
                  </td>
                  {/* "system" for a machine, matching the project log — a worker spending its
                      enrolment token has no session to attribute the row to */}
                  <td className="align-top font-medium sm:table-cell sm:whitespace-nowrap sm:px-3 sm:py-2">
                    {auditActor(log)}
                  </td>
                  <td
                    className={`w-full align-top sm:table-cell sm:w-auto sm:whitespace-nowrap sm:px-3 sm:py-2 ${
                      auditIsNotable(log) ? "text-danger" : "text-text-muted"
                    }`}
                  >
                    {auditActionLabel(log)}
                  </td>
                  <td className="align-top sm:table-cell sm:whitespace-nowrap sm:px-3 sm:py-2">
                    {log.target}
                  </td>
                  {/* w-full + max-w-0 is what lets a cell truncate instead of pushing the table
                      past its container */}
                  <td
                    className="w-full align-top text-text-muted sm:table-cell sm:max-w-0 sm:truncate sm:px-3 sm:py-2"
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
