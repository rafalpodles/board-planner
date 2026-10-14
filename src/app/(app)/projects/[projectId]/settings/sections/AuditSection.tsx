"use client";

import { useEffect, useRef } from "react";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Button } from "@/components/ui/Button";
import { AuditFilters } from "@/components/audit/AuditFilters";
import { useAuditLog } from "@/hooks/use-audit-log";
import { PROJECT_AUDIT_PAGE } from "@/lib/audit-page-size";
import { ApiProjectAuditLog, PROJECT_AUDIT_ACTIONS } from "@/types";
import { SettingsCard, EmptyState } from "@/components/settings/SettingsCard";

const ACTION_OPTIONS = PROJECT_AUDIT_ACTIONS.map((action) => ({ value: action, label: action.replace(/_/g, " ") }));

export function AuditSection({ projectId, active }: { projectId: string; active: boolean }) {
  const { rows, more, loading, failed, filters, apply, reload, loadMore } = useAuditLog<ApiProjectAuditLog>(
    `/api/projects/${projectId}/audit`,
    PROJECT_AUDIT_PAGE
  );
  const logs = rows ?? [];
  const started = useRef(false);

  useEffect(() => {
    if (!active || started.current) return;
    started.current = true;
    reload();
  }, [active, reload]);

  return (
    <SettingsCard title="Recent changes">
      <AuditFilters
        actions={ACTION_OPTIONS}
        applied={filters}
        onApply={apply}
        exportUrl={`/api/projects/${projectId}/audit/export`}
      />
      {rows === null && !failed ? (
        <div className="flex justify-center py-8" role="status" aria-label="Loading the audit log">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : rows === null ? (
        // Not the empty state: "nothing was ever changed here" is a claim about this board's
        // history, and a read that never answered supports no claim about it at all. The toast
        // fades; this stays until somebody has an answer
        <LoadFailed
          testId="project-audit-error"
          message="Failed to load the audit log."
          onRetry={reload}
        />
      ) : logs.length === 0 ? (
        <EmptyState>
          {Object.values(filters).some(Boolean) ? "No entries match these filters." : "No settings changes recorded yet."}
        </EmptyState>
      ) : (
        // A table, so the columns line up across rows: separate flex rows each sized
        // themselves, which is why "settings updated" wrapped in one row and not the next.
        // Four columns need width the phone has not got — three of them nowrap, which leaves the
        // one that carries the change a sliver — so below sm each entry is a block.
        <div className="max-h-[420px] overflow-y-auto">
          <table className="w-full text-xs">
            <tbody>
              {logs.map((log) => (
                <tr
                  key={log._id}
                  className="flex flex-wrap gap-x-2 border-b border-border/50 py-2 last:border-b-0 sm:table-row sm:py-0"
                >
                  <td className="align-top text-text-muted sm:table-cell sm:whitespace-nowrap sm:py-1.5 sm:pr-3">
                    {new Date(log.createdAt).toLocaleString()}
                  </td>
                  <td className="align-top font-medium sm:table-cell sm:whitespace-nowrap sm:py-1.5 sm:pr-3">
                    {log.user && typeof log.user === "object" ? log.user.username : log.user === null ? "Deleted user" : "system"}
                  </td>
                  <td className="align-top text-text-muted sm:table-cell sm:whitespace-nowrap sm:py-1.5 sm:pr-3">
                    {log.action.replace(/_/g, " ")}
                  </td>
                  {/* w-full + max-w-0 keeps the cell from pushing the table past its container;
                      the detail wraps inside it, one line per changed setting, because truncated
                      it cut off the value after the arrow — the part that matters */}
                  <td
                    data-testid="audit-detail"
                    className="w-full whitespace-pre-line break-words align-top text-text sm:table-cell sm:max-w-0 sm:py-1.5"
                  >
                    {log.lines?.length ? log.lines.join("\n") : (log.detail ?? "").replace(/\s+/g, " ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows !== null && failed && (
        <LoadFailed
          testId="project-audit-more-error"
          variant="row"
          className="mt-3"
          message="Failed to load more of the audit log."
          onRetry={loadMore}
        />
      )}
      {rows !== null && more && !failed && (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" size="sm" onClick={loadMore} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </SettingsCard>
  );
}
