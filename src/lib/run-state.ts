import { ApiTaskExecution } from "@/types";

const MINUTE = 60_000;

export const QUIET_MS = 5 * MINUTE;

export function ageAt(
  from: string | null | undefined,
  asOf: string | undefined,
  sinceFetch: number
): number {
  const start = from ? Date.parse(from) : NaN;
  const observed = asOf ? Date.parse(asOf) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(observed)) return NaN;
  return Math.max(0, observed - start) + sinceFetch;
}

export type RunState = "live" | "quiet";

export function runStateOf(
  execution: ApiTaskExecution | undefined,
  sinceFetch = 0
): RunState | null {
  if (!execution) return null;
  const silentFor = ageAt(execution.phaseAt ?? execution.startedAt, execution.asOf, sinceFetch);
  return Number.isFinite(silentFor) && silentFor > QUIET_MS ? "quiet" : "live";
}

export interface RunLook {
  dot: string;
  text: string;
}

export function runLook(state: RunState): RunLook {
  return state === "quiet"
    ? { dot: "bg-warning", text: "text-warning" }
    : {
        dot: "bg-danger ring-2 ring-danger/40 animate-pulse motion-reduce:animate-none",
        text: "text-danger",
      };
}
