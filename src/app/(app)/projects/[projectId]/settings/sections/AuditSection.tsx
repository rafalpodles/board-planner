"use client";

import { useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { ApiProjectAuditLog } from "@/types";
import { SettingsCard, EmptyState } from "@/components/settings/SettingsCard";

export function AuditSection({ projectId, active }: { projectId: string; active: boolean }) {
  const api = useApi();
  const { toast } = useToast();
  const [logs, setLogs] = useState<ApiProjectAuditLog[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!active || loaded) return;
    setLoaded(true);
    api
      .get(`/api/projects/${projectId}/audit`)
      .then(setLogs)
      .catch(() => toast("Failed to load audit log", "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, loaded, projectId]);

  return (
    <SettingsCard title="Recent changes">
      {logs.length === 0 ? (
        <EmptyState>No settings changes recorded yet.</EmptyState>
      ) : (
        // A table, so the columns line up across rows: separate flex rows each sized
        // themselves, which is why "settings updated" wrapped in one row and not the next.
        // Four columns need width the phone has not got — three of them nowrap, and the one
        // that carries the change truncates to nothing — so below sm each entry is a block.
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
                    {log.user && typeof log.user === "object" ? log.user.username : "system"}
                  </td>
                  <td className="align-top text-text-muted sm:table-cell sm:whitespace-nowrap sm:py-1.5 sm:pr-3">
                    {log.action.replace(/_/g, " ")}
                  </td>
                  {/* w-full + max-w-0 is what lets a table cell truncate instead of pushing
                      the table past its container; below sm it gets the whole next line
                      instead, because truncated to a phone's width it showed nothing */}
                  <td
                    className="w-full align-top text-text sm:table-cell sm:max-w-0 sm:truncate sm:py-1.5"
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
    </SettingsCard>
  );
}
