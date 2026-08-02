export const ACTIVITY_WINDOW_MS = 15 * 60_000;

export type ActivityStatus = "working" | "idle";

export function activityStatus(
  lastTaskUpdate: string | Date | number | null | undefined,
  now: number
): ActivityStatus | null {
  if (!lastTaskUpdate) return null;
  const at = new Date(lastTaskUpdate).getTime();
  if (Number.isNaN(at)) return null;
  return now - at < ACTIVITY_WINDOW_MS ? "working" : "idle";
}
