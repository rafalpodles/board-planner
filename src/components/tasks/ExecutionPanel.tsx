"use client";

import { useEffect, useState } from "react";
import { ApiTaskExecution } from "@/types";

interface ExecutionPanelProps {
  execution?: ApiTaskExecution;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// A run that has gone quiet is the thing a reader most needs to notice: a worker killed mid-task
// keeps its phase until the lease expires, and the lease is only swept when some worker next polls
// the project. The age is what tells them apart, so it is never rounded away to "just now".
export function elapsedLabel(from: string, now: number): string {
  const started = Date.parse(from);
  if (!Number.isFinite(started)) return "";
  const ms = now - started;
  if (ms < 0) return "just now";
  if (ms < MINUTE) return `${Math.floor(ms / 1000)}s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MINUTE)}m`;
}

export function ExecutionPanel({ execution }: ExecutionPanelProps) {
  const phase = execution?.phase;
  const phaseAt = execution?.phaseAt;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!phase || !phaseAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase, phaseAt]);

  // No phase means no run: the field is unset the moment a task leaves the active column, so an
  // absent phase is always current rather than stale
  if (!phase) return null;

  const age = phaseAt ? elapsedLabel(phaseAt, now) : "";

  return (
    <div>
      <h2 className="font-semibold mb-2">Execution</h2>
      <div className="flex items-center gap-2 text-sm">
        <span
          className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"
          aria-hidden="true"
        />
        <span className="font-medium">{phase}</span>
        {age && <span className="text-gray-500 dark:text-gray-400">· {age}</span>}
        {execution?.workerId && (
          <span className="text-gray-500 dark:text-gray-400">· {execution.workerId}</span>
        )}
      </div>
    </div>
  );
}
