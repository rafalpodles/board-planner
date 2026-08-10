import { ApiTaskExecution } from "@/types";

const MINUTE = 60_000;

// Past this a run that is still working has gone quiet for longer than any normal gap between
// tool calls, so the board stops claiming it is alive. Shared by every view that says so.
export const QUIET_MS = 5 * MINUTE;

/**
 * Both instants come from the server, so their difference is skew-free. Only the time elapsed
 * since the page received them is measured locally, and a local delta is safe: it is a duration,
 * not a comparison between two clocks.
 */
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

/**
 * What a run looks like from the outside, or null when none holds the task.
 *
 * Silence is measured from the last phase report, falling back to the claim: phase events are
 * fire-and-forget and may be dropped, so a worker that claimed a task and died before reporting
 * has no phaseAt at all, and an absent one would otherwise read as live for the whole lease.
 */
export function runStateOf(
  execution: ApiTaskExecution | undefined,
  sinceFetch = 0
): RunState | null {
  if (!execution) return null;
  const silentFor = ageAt(execution.phaseAt ?? execution.startedAt, execution.asOf, sinceFetch);
  return Number.isFinite(silentFor) && silentFor > QUIET_MS ? "quiet" : "live";
}

export interface RunLook {
  /** Classes for the small round indicator every view draws. */
  dot: string;
  /** Text colour for a label sitting beside it. */
  text: string;
}

/**
 * What each state looks like, in one place. The three views drew this themselves and drifted:
 * the card and the list row painted a live run `bg-danger` while the execution panel painted the
 * same run `bg-success`, so opening a task changed its colour from red to green.
 *
 * Red for a live run is deliberate and was asked for — it is the board's "a machine is touching
 * this right now" signal, not an error. `bg-danger` is reserved for failure everywhere else, so
 * this is the one place that reads it differently, and that is why it is written down once.
 */
export function runLook(state: RunState): RunLook {
  return state === "quiet"
    ? { dot: "bg-warning", text: "text-warning" }
    : { dot: "bg-danger animate-pulse motion-reduce:animate-none", text: "text-danger" };
}
