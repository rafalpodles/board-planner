"use client";

import { ApiTaskExecution } from "@/types";
import { runStateOf } from "@/lib/run-state";

/**
 * A worker holds this task — the compact form, for rows where a card's phase label would not fit.
 * The list had nothing at all before this: the only way to learn a task was being executed was to
 * try to move it and be refused.
 */
export function RunDot({ execution }: { execution?: ApiTaskExecution }) {
  const state = runStateOf(execution);
  if (!state) return null;

  const who = execution?.workerName || execution?.workerId || "a worker";
  const phase = execution?.phase ?? "starting";

  return (
    <span
      data-testid={state === "quiet" ? "row-run-quiet" : "row-run-live"}
      title={
        state === "quiet"
          ? `No sign of life — ${who} · ${phase}`
          : `Being executed — ${who} · ${phase}`
      }
      className="inline-flex shrink-0 items-center"
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          state === "quiet" ? "bg-warning" : "bg-danger animate-pulse motion-reduce:animate-none"
        }`}
      />
      <span className="sr-only">
        {state === "quiet"
          ? `Worker has gone quiet on this task: ${phase}`
          : `Being executed by a worker: ${phase}`}
      </span>
    </span>
  );
}
