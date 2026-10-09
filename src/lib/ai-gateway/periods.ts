import type { AiBudgetKind } from "@/models/aiBudget";

export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);
export const utcMonth = (at: Date): string => at.toISOString().slice(0, 7);

export function periodOf(kind: AiBudgetKind, at: Date): string {
  if (kind === "day") return utcDay(at);
  if (kind === "month") return utcMonth(at);
  return "all";
}

export function nextUtcMidnight(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1));
}

export function nextUtcMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}
