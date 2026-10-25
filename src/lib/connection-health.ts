import type { ApiRepositoryConnection } from "@/types";

export const EXPIRY_WARNING_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ConnectionHealth =
  | { state: "rejected"; since: Date }
  | { state: "expired"; on: Date }
  | { state: "expiring"; on: Date; daysLeft: number }
  | { state: "ok" }
  | { state: "unknown" };

export function connectionHealth(connection: ApiRepositoryConnection | undefined, now = new Date()): ConnectionHealth {
  if (!connection) return { state: "unknown" };
  if (connection.rejectedAt) return { state: "rejected", since: new Date(connection.rejectedAt) };
  if (connection.expiresAt) {
    const on = new Date(connection.expiresAt);
    const left = on.getTime() - now.getTime();
    if (left <= 0) return { state: "expired", on };
    if (left <= EXPIRY_WARNING_DAYS * DAY_MS) return { state: "expiring", on, daysLeft: Math.ceil(left / DAY_MS) };
  }
  if (connection.lastSyncAt || connection.login) return { state: "ok" };
  return { state: "unknown" };
}

export function formatDay(at: Date): string {
  return at.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: at.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export function formatMoment(at: Date): string {
  return `${formatDay(at)}, ${at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/** The badge a connection row shows instead of "Connected", or null when "Connected" is true. */
export function healthBadge(health: ConnectionHealth): { label: string; tone: "danger" | "warning" } | null {
  switch (health.state) {
    case "rejected":
      return { label: "Token rejected", tone: "danger" };
    case "expired":
      return { label: "Token expired", tone: "danger" };
    case "expiring":
      return { label: `Expires in ${health.daysLeft} ${health.daysLeft === 1 ? "day" : "days"}`, tone: "warning" };
    default:
      return null;
  }
}
