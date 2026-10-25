"use client";

import type { ApiRepositoryConnection } from "@/types";
import { connectionHealth, formatDay, formatMoment } from "@/lib/connection-health";

interface Props {
  provider: "GitHub" | "GitLab";
  connection: ApiRepositoryConnection | undefined;
  /** "pull requests" or "merge requests" */
  requests: string;
}

const BOX = "rounded-lg border bg-bg-input/40 px-3 py-2 text-sm";

export function ConnectionStatus({ provider, connection, requests }: Props) {
  const health = connectionHealth(connection);
  if (health.state === "rejected") {
    return (
      <div role="status" className={`${BOX} border-danger/40`}>
        <p className="font-medium text-danger">
          {provider} rejected this token on {formatMoment(health.since)}.
        </p>
        <p className="text-text-muted">
          It has expired or was revoked. {capitalise(requests)} on this board have not updated since. Paste a new
          token below.
        </p>
      </div>
    );
  }
  if (health.state === "expired" || health.state === "expiring") {
    const past = health.state === "expired";
    return (
      <div role="status" className={`${BOX} ${past ? "border-danger/40" : "border-warning/40"}`}>
        <p className={`font-medium ${past ? "text-danger" : "text-warning"}`}>
          This token {past ? "expired" : "expires"} on {formatDay(health.on)}.
        </p>
        <p className="text-text-muted">
          {past ? `${capitalise(requests)} stopped linking then.` : `After that ${requests} stop linking.`} Paste a
          new one{past ? "" : " before then"}.
        </p>
      </div>
    );
  }
  if (health.state === "unknown" || !connection) return null;
  return (
    <div role="status" className={`${BOX} border-border`}>
      {connection.login && (
        <p>
          Token of <span className="font-medium">{connection.login}</span>
          {connection.expiresAt ? `, expires ${formatDay(new Date(connection.expiresAt))}.` : ", with no expiry."}
        </p>
      )}
      {connection.lastSyncAt && (
        <p className="text-text-muted">
          Last synced {formatMoment(new Date(connection.lastSyncAt))}: {connection.lastSyncLinked}{" "}
          {connection.lastSyncLinked === 1 ? requests.replace(/s$/, "") : requests} linked to{" "}
          {connection.lastSyncTasks} {connection.lastSyncTasks === 1 ? "task" : "tasks"}.
        </p>
      )}
    </div>
  );
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
