"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { useAuditLog } from "@/hooks/use-audit-log";
import { INSTANCE_AUDIT_PAGE } from "@/lib/audit-page-size";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Button } from "@/components/ui/Button";
import { AuditFilters } from "@/components/audit/AuditFilters";
import { ApiInstanceAuditLog, INSTANCE_AUDIT_ACTIONS } from "@/types";
import { auditActionLabel, auditActor, auditIsNotable } from "@/lib/instance-audit-view";


const ACTION_OPTIONS = INSTANCE_AUDIT_ACTIONS.map((action) => ({
  value: action,
  label: action === "worker_command_sent" ? "Worker told to stop or pause" : auditActionLabel({ action, detail: "" }),
}));

export default function InstanceAuditPage() {
  const router = useRouter();
  const { isAdmin, isLoading: authLoading } = useAuth();
  const { rows: logs, more, loading, failed, filters, apply, reload, loadMore } = useAuditLog<ApiInstanceAuditLog>(
    "/api/admin/audit",
    INSTANCE_AUDIT_PAGE
  );

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin) {
      router.replace("/projects");
      return;
    }
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, authLoading, router]);

  if (authLoading) {
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
        <h2 className="text-lg font-semibold mb-1">Audit log</h2>
        <p className="text-sm text-text-muted">
          Organisation-wide actions: stopping a machine, enrolling one, committing a project to
          workers, an account created, made an administrator or deleted, and anything that changes
          how an account is signed into — a password set for somebody, a reset by email, or an
          address moved, whether by an administrator or by the account itself. Each project keeps
          its own log of its own settings, under that project.
        </p>
      </div>

      <AuditFilters actions={ACTION_OPTIONS} applied={filters} onApply={apply} exportUrl="/api/admin/audit/export" />

      {logs === null && !failed ? (
        <div className="flex justify-center py-12" role="status" aria-label="Loading the audit log">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
        </div>
      ) : logs === null ? (
        // Not the empty state: "nothing recorded yet" is a claim about this instance's history
        <LoadFailed
          testId="instance-audit-error"
          message="Failed to load the audit log."
          onRetry={reload}
        />
      ) : logs.length === 0 ? (
        <p className="text-sm text-text-muted">
          {Object.values(filters).some(Boolean) ? "No entries match these filters." : "Nothing recorded yet."}
        </p>
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

      {logs !== null && failed && (
        <LoadFailed
          testId="instance-audit-more-error"
          variant="row"
          className="mt-3"
          message="Failed to load more of the audit log."
          onRetry={loadMore}
        />
      )}
      {logs !== null && more && !failed && (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" size="sm" onClick={loadMore} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
