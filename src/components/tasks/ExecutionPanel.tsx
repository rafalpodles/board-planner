"use client";

import { useEffect, useState } from "react";
import { ApiTaskExecution } from "@/types";

interface ExecutionPanelProps {
  execution?: ApiTaskExecution;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Past this, a run that is still emitting has gone quiet for longer than any normal gap between
// tool calls, so the panel stops claiming it is alive
const QUIET_MS = 5 * MINUTE;

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
  const startedAt = execution?.startedAt;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!phase) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // No phase means no run: the field is unset the moment a task leaves the active column, so an
  // absent phase is always current rather than stale
  if (!phase) return null;

  const sinceLastSign = phaseAt ? now - Date.parse(phaseAt) : NaN;
  const quiet = Number.isFinite(sinceLastSign) && sinceLastSign > QUIET_MS;

  return (
    <div>
      <h2 className="font-semibold mb-2">Execution</h2>
      <div className="flex items-center gap-2 text-sm">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            quiet ? "bg-amber-500" : "bg-emerald-500 animate-pulse"
          }`}
          aria-hidden="true"
        />
        <span className="font-medium">{phase}</span>
        {/* Two different clocks, so they are labelled rather than shown as one number: during the
            agent stage every tool call refreshes phaseAt, so its age is time since the last sign of
            life, not time spent. Only startedAt answers "how long has this been going". */}
        {startedAt && (
          <span className="text-gray-500 dark:text-gray-400">
            · running {elapsedLabel(startedAt, now)}
          </span>
        )}
        {phaseAt && (
          <span className={quiet ? "text-amber-600 dark:text-amber-400" : "text-gray-500 dark:text-gray-400"}>
            · last sign of life {elapsedLabel(phaseAt, now)} ago
          </span>
        )}
        {execution?.workerId && (
          <span className="text-gray-500 dark:text-gray-400">· {execution.workerId}</span>
        )}
      </div>
    </div>
  );
}
