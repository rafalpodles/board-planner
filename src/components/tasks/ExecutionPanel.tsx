"use client";

import { useEffect, useRef, useState } from "react";
import { ApiTaskExecution } from "@/types";
import { SectionLabel } from "@/components/tasks/detail/atoms";

interface ExecutionPanelProps {
  execution?: ApiTaskExecution;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Past this, a run that is still working has gone quiet for longer than any normal gap between
// tool calls, so the panel stops claiming it is alive
const QUIET_MS = 5 * MINUTE;

export function durationLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < MINUTE) return `${Math.floor(ms / 1000)}s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MINUTE)}m`;
}

// Both instants come from the server, so their difference is skew-free. Only the time elapsed
// since the page received them is measured locally, and a local delta is safe: it is a duration,
// not a comparison between two clocks.
export function ageAt(from: string | null | undefined, asOf: string | undefined, sinceFetch: number): number {
  const start = from ? Date.parse(from) : NaN;
  const observed = asOf ? Date.parse(asOf) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(observed)) return NaN;
  return Math.max(0, observed - start) + sinceFetch;
}

export function ExecutionPanel({ execution }: ExecutionPanelProps) {
  const { phase, phaseAt, startedAt, asOf, workerId, workerName } = execution ?? {};
  const receivedAt = useRef(Date.now());
  const [sinceFetch, setSinceFetch] = useState(0);

  useEffect(() => {
    receivedAt.current = Date.now();
    setSinceFetch(0);
  }, [asOf, phase, phaseAt]);

  useEffect(() => {
    if (!phase) return;
    const timer = setInterval(() => setSinceFetch(Date.now() - receivedAt.current), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // No phase means no run: the field is unset the moment a task leaves the active column, so an
  // absent phase is never a stale one. A worker that has claimed but not yet reported still shows,
  // as "starting", so a held task is never silently invisible.
  if (!phase && !workerId) return null;

  const quietFor = ageAt(phaseAt, asOf, sinceFetch);
  const runningFor = ageAt(startedAt, asOf, sinceFetch);
  const quiet = Number.isFinite(quietFor) && quietFor > QUIET_MS;
  const running = durationLabel(runningFor);
  const silent = durationLabel(quietFor);

  return (
    <section className="flex flex-col gap-2.5">
      <SectionLabel>Execution</SectionLabel>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            quiet ? "bg-warning" : "bg-success animate-pulse"
          }`}
          data-testid={quiet ? "run-quiet" : "run-live"}
          aria-hidden="true"
        />
        <span className="font-medium">{phase ?? "starting"}</span>
        {/* Two clocks that mean different things: during the agent stage every tool call refreshes
            phaseAt, so its age is time since the last sign of life, not time spent. Only startedAt
            answers "how long has this been going". */}
        {running && <span className="text-text-muted">· running {running}</span>}
        {silent && (
          <span className={quiet ? "text-warning" : "text-text-muted"}>
            · last sign of life {silent} ago
          </span>
        )}
        {(workerName || workerId) && (
          <span className="text-text-muted">· {workerName || workerId}</span>
        )}
      </div>
    </section>
  );
}
