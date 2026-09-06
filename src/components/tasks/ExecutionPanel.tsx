"use client";

import { useEffect, useRef, useState } from "react";
import { ApiTaskExecution } from "@/types";
import { SectionLabel } from "@/components/tasks/detail/atoms";

interface ExecutionPanelProps {
  execution?: ApiTaskExecution;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

import { QUIET_MS, ageAt, runLook } from "@/lib/run-state";
export { QUIET_MS, ageAt };

export function durationLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < MINUTE) return `${Math.floor(ms / 1000)}s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MINUTE)}m`;
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

  if (!phase && !workerId) return null;

  const quietFor = ageAt(phaseAt, asOf, sinceFetch);
  const runningFor = ageAt(startedAt, asOf, sinceFetch);
  const quiet = Number.isFinite(quietFor) && quietFor > QUIET_MS;
  const look = runLook(quiet ? "quiet" : "live");
  const running = durationLabel(runningFor);
  const silent = durationLabel(quietFor);

  return (
    <section className="flex flex-col gap-2.5">
      <SectionLabel>Execution</SectionLabel>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span
          className={`inline-block w-2 h-2 rounded-full ${look.dot}`}
          data-testid={quiet ? "run-quiet" : "run-live"}
          aria-hidden="true"
        />
        <span className="font-medium">{phase ?? "starting"}</span>
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
