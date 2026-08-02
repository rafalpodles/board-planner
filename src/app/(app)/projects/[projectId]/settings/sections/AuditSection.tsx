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
    <SettingsCard title="Recent changes" contract="readonly">
      {logs.length === 0 ? (
        <EmptyState>No settings changes recorded yet.</EmptyState>
      ) : (
        <div className="max-h-[420px] space-y-1 overflow-y-auto">
          {logs.map((log) => (
            <div
              key={log._id}
              className="flex items-start gap-2 border-b border-border/50 py-1.5 text-xs last:border-b-0"
            >
              <span className="whitespace-nowrap text-text-muted">
                {new Date(log.createdAt).toLocaleString()}
              </span>
              <span className="whitespace-nowrap font-medium">
                {typeof log.user === "object" ? log.user.username : "system"}
              </span>
              <span className="text-text-muted">{log.action.replace(/_/g, " ")}</span>
              {log.detail && <span className="truncate text-text">{log.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </SettingsCard>
  );
}
