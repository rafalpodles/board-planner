import { AnyColumn } from "./columns";

// `id` is optional because a column added in settings has none until it is saved, and an
// unsaved column has no identity to hand off to
type Column = { id?: string; role: AnyColumn["role"]; triggersPmReview?: boolean };

/**
 * The one column that means "a human or the PM agent needs to look at this".
 *
 * Three readers used to resolve this independently — `task-service`, the worker and the
 * PM trigger — and the PM trigger used a different rule, firing on any flagged column
 * whatever its role. They agree here instead.
 */
export function escalationColumnId(columns: Column[]): string | undefined {
  const review = columns.filter((c) => c.role === "review");
  return (review.find((c) => c.triggersPmReview) ?? review[0])?.id;
}

/** Every column carrying the flag, so settings can warn about ones about to lose it. */
export function flaggedColumnIds(columns: Column[]): string[] {
  return columns.flatMap((c) => (c.triggersPmReview && c.id ? [c.id] : []));
}

export function withEscalationColumn<T extends Column>(columns: T[], id: string | null): T[] {
  const chosen = columns.find((c) => c.id === id && c.role === "review")?.id ?? null;
  return columns.map((c) => ({ ...c, triggersPmReview: c.id === chosen }));
}
