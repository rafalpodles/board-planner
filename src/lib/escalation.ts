import { AnyColumn } from "./columns";

type Column = { id?: string; role: AnyColumn["role"]; triggersPmReview?: boolean };

export function escalationColumnId(columns: Column[]): string | undefined {
  const review = columns.filter((c) => c.role === "review");
  return (review.find((c) => c.triggersPmReview) ?? review[0])?.id;
}

export function explicitEscalationColumnId(columns: Column[]): string | undefined {
  return columns.find((c) => c.role === "review" && c.triggersPmReview)?.id;
}

export function flaggedColumnIds(columns: Column[]): string[] {
  return columns.flatMap((c) => (c.triggersPmReview && c.id ? [c.id] : []));
}

export function withEscalationColumn<T extends Column>(columns: T[], id: string | null): T[] {
  const chosen = columns.find((c) => c.id === id && c.role === "review")?.id ?? null;
  return columns.map((c) => ({ ...c, triggersPmReview: c.id === chosen }));
}
