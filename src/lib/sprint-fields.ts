import { SPRINT_STATUSES, type SprintStatus } from "@/types";

export interface SprintFieldUpdates {
  name?: string;
  goal?: string;
  status?: SprintStatus;
  startDate?: Date;
  endDate?: Date;
}

export type SprintFieldCheck = { ok: true; updates: SprintFieldUpdates } | { ok: false; error: string };

function readDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function checkSprintFields(
  body: Record<string, unknown>,
  stored?: { startDate: Date; endDate: Date }
): SprintFieldCheck {
  const updates: SprintFieldUpdates = {};

  if (body.status !== undefined) {
    if (!SPRINT_STATUSES.includes(body.status as SprintStatus)) return { ok: false, error: "Invalid sprint status" };
    updates.status = body.status as SprintStatus;
  }
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim() === "") return { ok: false, error: "A sprint needs a name" };
    updates.name = body.name;
  }
  if (body.goal !== undefined) {
    if (typeof body.goal !== "string") return { ok: false, error: "Invalid goal" };
    updates.goal = body.goal;
  }
  for (const field of ["startDate", "endDate"] as const) {
    if (body[field] === undefined) continue;
    const date = readDate(body[field]);
    if (!date) return { ok: false, error: `Invalid ${field}` };
    updates[field] = date;
  }

  const start = updates.startDate ?? stored?.startDate;
  const end = updates.endDate ?? stored?.endDate;
  if (start && end && end.getTime() < start.getTime()) {
    return { ok: false, error: "endDate must not be before startDate" };
  }

  return { ok: true, updates };
}
