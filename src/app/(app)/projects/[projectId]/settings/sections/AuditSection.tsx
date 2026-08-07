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
        // themselves, which is why "settings updated" wrapped in one row and not the next
        <div className="max-h-[420px] overflow-y-auto">
          <table className="w-full text-xs">
            <tbody>
              {logs.map((log) => (
                <tr key={log._id} className="border-b border-border/50 last:border-b-0">
                  <td className="whitespace-nowrap py-1.5 pr-3 align-top text-text-muted">
                    {new Date(log.createdAt).toLocaleString()}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 align-top font-medium">
                    {log.user && typeof log.user === "object" ? log.user.username : "system"}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 align-top text-text-muted">
                    {log.action.replace(/_/g, " ")}
                  </td>
                  {/* w-full + max-w-0 is what lets a table cell truncate instead of
                      pushing the table past its container */}
                  <td
                    className="w-full max-w-0 truncate py-1.5 align-top text-text"
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
